// backend/index.js
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const axios = require("axios");
const { MongoClient, ObjectId, ServerApiVersion } = require("mongodb");
require("dotenv").config();
const PDFDocument = require("pdfkit");
const helmet = require("helmet");
const compression = require("compression");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 5000;

const api = express.Router();

const isDev = process.env.NODE_ENV !== "production";

const logger = {
  log: (...args) => {
    if (isDev) {
      console.log(...args);
    }
  },
  error: (...args) => console.error(...args),
  warn: (...args) => console.warn(...args),
};

app.set("trust proxy", 1);

// Middleware
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://localhost:5174",
      "http://localhost:5175",
      "http://localhost:5176",
      "https://bdprogramming.com",
      "https://www.bdprogramming.com",
    ],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  }),
);
app.use(express.json());
app.use(helmet());
app.use(compression());
app.use(morgan("combined"));

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many requests. Please try again later.",
  },
});

app.use(globalLimiter);

// bKash Configuration
const BKASH_CONFIG = {
  app_key: process.env.BKASH_APP_KEY,
  app_secret: process.env.BKASH_APP_SECRET,
  username: process.env.BKASH_USERNAME,
  password: process.env.BKASH_PASSWORD,
  base_url: process.env.BKASH_BASE_URL,
  frontend_url: process.env.BKASH_FRONTEND_URL,
};

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// Slug Generator Functions
function generateSlug(title) {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/--+/g, "-");
}

async function createUniqueSlug(title, collection) {
  let slug = generateSlug(title);
  let uniqueSlug = slug;
  let counter = 1;

  while (await collection.findOne({ slug: uniqueSlug })) {
    uniqueSlug = `${slug}-${counter}`;
    counter++;
  }

  return uniqueSlug;
}

// Validate required environment variables
const requiredEnvVars = ["JWT_SECRET", "EMAIL_USER", "EMAIL_PASS"];
const missingVars = requiredEnvVars.filter((varName) => !process.env[varName]);

if (missingVars.length > 0) {
  logger.error(
    `❌ Missing required environment variables: ${missingVars.join(", ")}`,
  );
  process.exit(1);
}

if (
  process.env.NODE_ENV === "production" &&
  !process.env.RECAPTCHA_SECRET_KEY
) {
  logger.warn(
    "⚠️ RECAPTCHA_SECRET_KEY not set. reCAPTCHA verification will fail!",
  );
}
// MongoDB local connection
// const uri = "mongodb://localhost:27017";

// MongoDB Atlas Connection
// const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.zn6isea.mongodb.net/?appName=Cluster0`;

const uri = process.env.MONGO_URI;

// Create a MongoClient
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// ============= ENHANCED REGISTRATION WITH RECAPTCHA & EMAIL VERIFICATION =============

// reCAPTCHA verification helper
async function verifyRecaptcha(token) {
  try {
    const secretKey = process.env.RECAPTCHA_SECRET_KEY;
    if (!secretKey) {
      logger.error("❌ RECAPTCHA_SECRET_KEY not configured");
      return false;
    }

    const response = await axios.post(
      "https://www.google.com/recaptcha/api/siteverify",
      null,
      {
        params: {
          secret: secretKey,
          response: token,
        },
        timeout: 5000,
      },
    );

    return response.data.success === true;
  } catch (error) {
    logger.error("reCAPTCHA verification error:", error);
    return false;
  }
}

// Check if password has been pwned
async function isPasswordPwned(password) {
  try {
    const crypto = require("crypto");

    const sha1 = crypto
      .createHash("sha1")
      .update(password)
      .digest("hex")
      .toUpperCase();

    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);

    const response = await axios.get(
      `https://api.pwnedpasswords.com/range/${prefix}`,
      {
        timeout: 5000,
      },
    );

    const data = response.data;

    return data.includes(suffix);
  } catch (error) {
    logger.warn("Pwned passwords API error:", error.message);
    return false;
  }
}

global.loginAttempts = new Map();

setInterval(
  () => {
    if (global.rateLimitStore) {
      const now = Date.now();

      for (const [key, attempts] of global.rateLimitStore.entries()) {
        const recentAttempts = attempts.filter(
          (timestamp) => now - timestamp < 3600000,
        );

        if (recentAttempts.length === 0) {
          global.rateLimitStore.delete(key);
        } else {
          global.rateLimitStore.set(key, recentAttempts);
        }
      }
    }
    if (global.loginAttempts) {
      const now = Date.now();

      for (const [key, value] of global.loginAttempts.entries()) {
        if (value.blockUntil && now > value.blockUntil) {
          global.loginAttempts.delete(key);
        }
      }
    }
    if (global.contactRateLimit) {
      const now = Date.now();

      for (const [key, attempts] of global.contactRateLimit.entries()) {
        const recentAttempts = attempts.filter(
          (timestamp) => now - timestamp < 3600000,
        );

        if (recentAttempts.length === 0) {
          global.contactRateLimit.delete(key);
        } else {
          global.contactRateLimit.set(key, recentAttempts);
        }
      }
    }
  },
  30 * 60 * 1000,
);

async function run() {
  try {
    // Connect the client to the server
    await client.connect();
    logger.log("Connected to MongoDB");

    const db = client.db("lmsDB");
    const courseCollection = db.collection("courses");
    const chapterCollection = db.collection("chapters");
    const lessonCollection = db.collection("lessons");
    const topicCollection = db.collection("topics");
    const userCollection = db.collection("users");
    const otpCollection = db.collection("otp");
    const certificateCollection = db.collection("certificates");
    const paymentCollection = db.collection("payments");
    const emailLogCollection = db.collection("emailLogs");
    const testimonialCollection = db.collection("testimonials");
    const contactCollection = db.collection("contacts");
    const reviewCollection = db.collection("reviews");
    // ============= Blog Post Collections =============
    const postCollection = db.collection("posts");
    const commentCollection = db.collection("comments");
    // ============= ANALYTICS COLLECTIONS =============
    const courseAnalyticsCollection = db.collection("courseAnalytics");
    const userAnalyticsCollection = db.collection("userAnalytics");
    const revenueAnalyticsCollection = db.collection("revenueAnalytics");

    // Index for posts
    await postCollection.createIndex({ status: 1 });
    await postCollection.createIndex({ createdAt: -1 });
    await postCollection.createIndex({ category: 1 });
    await postCollection.createIndex({ authorId: 1 });
    await postCollection.createIndex({ status: 1, createdAt: -1 });

    // Create indexes
    await courseAnalyticsCollection.createIndex({ courseId: 1 });
    await courseAnalyticsCollection.createIndex({ date: -1 });
    await userAnalyticsCollection.createIndex({ userId: 1 });
    await userAnalyticsCollection.createIndex({ courseId: 1, date: -1 });

    // Create indexes for better performance
    await courseCollection.createIndex({ slug: 1 }, { unique: true });
    await courseCollection.createIndex({ status: 1 });
    await courseCollection.createIndex({ level: 1 });
    await courseCollection.createIndex({ createdAt: -1 });
    await chapterCollection.createIndex({ courseId: 1, order: 1 });
    await lessonCollection.createIndex({ chapterId: 1, order: 1 });
    await topicCollection.createIndex({ lessonId: 1, order: 1 });

    // Create indexes for user collections
    await userCollection.createIndex({ email: 1 }, { unique: true });
    await userCollection.createIndex({ uniqueId: 1 }, { unique: true });
    await otpCollection.createIndex({ email: 1 });
    await otpCollection.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0 },
    );
    await certificateCollection.createIndex({ userId: 1 });
    await certificateCollection.createIndex(
      { certificateId: 1 },
      { unique: true },
    );
    await userCollection.createIndex({ "notifications.createdAt": -1 });

    logger.log("Database indexes created");

    await paymentCollection.createIndex(
      { trxID: 1 },
      { unique: true, sparse: true },
    );
    await paymentCollection.createIndex(
      { merchantInvoiceNumber: 1 },
      { unique: true },
    );
    await paymentCollection.createIndex({ status: 1 });
    await paymentCollection.createIndex({ userId: 1 });
    await paymentCollection.createIndex({ courseId: 1 });
    logger.log("Payment indexes created");

    // Create indexes for email logs collection
    await emailLogCollection.createIndex({ userId: 1 });
    await emailLogCollection.createIndex({ merchantInvoiceNumber: 1 });
    await emailLogCollection.createIndex({ sentAt: -1 });
    logger.log("✅ Email logs indexes created");

    // Create indexes for testimonials
    await testimonialCollection.createIndex({ status: 1, isApproved: 1 });
    await testimonialCollection.createIndex({ createdAt: -1 });

    // Create indexes for review
    await reviewCollection.createIndex(
      { courseId: 1, userId: 1 },
      { unique: true },
    ); // One review per user per course
    await reviewCollection.createIndex({ courseId: 1, createdAt: -1 });
    await reviewCollection.createIndex({ rating: -1 });
    await reviewCollection.createIndex({ isApproved: 1 });

    // Middleware to check if user is admin
    async function isAdmin(req, res, next) {
      try {
        // Check if req.user exists
        if (!req.user) {
          logger.error("❌ isAdmin: No user object in request");
          return res.status(401).json({
            success: false,
            message: "Authentication required",
          });
        }

        const userId = req.user.userId;

        logger.log("🔍 isAdmin checking userId:", userId);

        // Validate userId exists
        if (!userId) {
          logger.error("❌ isAdmin: No userId in token");
          return res.status(400).json({
            success: false,
            message: "Invalid token: No user ID",
          });
        }

        // Validate userId format
        if (!ObjectId.isValid(userId)) {
          logger.error("❌ isAdmin: Invalid userId format:", userId);
          return res.status(400).json({
            success: false,
            message: "Invalid user ID format in token",
          });
        }

        const user = await userCollection.findOne({
          _id: new ObjectId(userId),
        });

        if (!user) {
          logger.error("❌ isAdmin: User not found for ID:", userId);
          return res.status(404).json({
            success: false,
            message: "User not found",
          });
        }

        if (user.role !== "admin") {
          logger.error("❌ isAdmin: User is not admin. Role:", user.role);
          return res.status(403).json({
            success: false,
            message: "Admin access required",
          });
        }

        logger.log("✅ isAdmin: User authorized as admin:", user.email);
        next();
      } catch (error) {
        logger.error("❌ isAdmin middleware error:", error);
        res.status(500).json({
          success: false,
          message: "Authorization error",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    }
    // ============= AUTHENTICATION MIDDLEWARE =============
    // Middleware to authenticate token
    function authenticateToken(req, res, next) {
      const authHeader = req.headers["authorization"];
      const token = authHeader && authHeader.split(" ")[1];

      if (!token) {
        return res
          .status(401)
          .json({ success: false, message: "Authentication required" });
      }

      jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
          return res
            .status(403)
            .json({ success: false, message: "Invalid or expired token" });
        }
        req.user = user;
        next();
      });
    }

    // ============= HELPER FUNCTIONS =============
    // Helper function to generate unique invoice number

    function checkLoginAttempts(ip, email) {
      const key = `${ip}_${email}`;
      const attempts = global.loginAttempts.get(key);

      if (!attempts) {
        return {
          blocked: false,
        };
      }

      const now = Date.now();

      // Remove expired block
      if (attempts.blockUntil && now > attempts.blockUntil) {
        global.loginAttempts.delete(key);

        return {
          blocked: false,
        };
      }

      // Still blocked
      if (attempts.blockUntil && now < attempts.blockUntil) {
        return {
          blocked: true,
          remainingTime: Math.ceil((attempts.blockUntil - now) / 60000),
        };
      }

      return {
        blocked: false,
      };
    }

    function recordFailedLogin(ip, email) {
      const key = `${ip}_${email}`;

      const existing = global.loginAttempts.get(key) || {
        count: 0,
        firstAttempt: Date.now(),
      };

      // Reset attempts after 15 minutes
      if (Date.now() - existing.firstAttempt > 15 * 60 * 1000) {
        existing.count = 0;
        existing.firstAttempt = Date.now();
      }

      existing.count += 1;

      // Block after 5 failed attempts
      if (existing.count >= 5) {
        existing.blockUntil = Date.now() + 15 * 60 * 1000;
      }

      global.loginAttempts.set(key, existing);
    }

    function clearLoginAttempts(ip, email) {
      const key = `${ip}_${email}`;
      global.loginAttempts.delete(key);
    }

    function generateInvoiceNumber() {
      const timestamp = Date.now().toString();
      const random = Math.floor(Math.random() * 10000)
        .toString()
        .padStart(4, "0");
      return `INV-${timestamp}-${random}`;
    }
    // Generate unique student ID
    async function generateUniqueStudentId() {
      const year = new Date().getFullYear();
      const count = await userCollection.countDocuments();
      const sequential = (count + 1).toString().padStart(4, "0");
      return `LMS${year}${sequential}`;
    }

    // Generate OTP
    function generateOTP() {
      return Math.floor(100000 + Math.random() * 900000).toString();
    }

    // Generate verification hash for certificates
    function generateVerificationHash() {
      return require("crypto").randomBytes(16).toString("hex");
    }

    // Email transporter configuration
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    // ============= NOTIFICATION SERVICE =============
    const notificationService = {
      // Send notification to a single user
      sendToUser: async (userId, notification) => {
        try {
          const notificationWithId = {
            ...notification,
            _id: new ObjectId(),
            createdAt: new Date(),
            read: false,
          };

          await userCollection.updateOne(
            { _id: new ObjectId(userId) },
            { $push: { notifications: notificationWithId } },
          );

          // Optional: Emit socket event for real-time notification
          // io.to(userId).emit('new-notification', notificationWithId);

          return notificationWithId;
        } catch (error) {
          logger.error("Send notification error:", error);
        }
      },

      // Send notification to multiple users
      sendToMany: async (userIds, notification) => {
        try {
          const notificationWithId = {
            ...notification,
            _id: new ObjectId(),
            createdAt: new Date(),
            read: false,
          };

          await userCollection.updateMany(
            { _id: { $in: userIds.map((id) => new ObjectId(id)) } },
            { $push: { notifications: notificationWithId } },
          );

          return notificationWithId;
        } catch (error) {
          logger.error("Send bulk notifications error:", error);
        }
      },

      // Send to all students enrolled in a course
      sendToCourseStudents: async (courseId, notification) => {
        try {
          const students = await userCollection
            .find({
              "enrolledCourses.courseId": new ObjectId(courseId),
            })
            .toArray();

          const studentIds = students.map((s) => s._id);

          return await notificationService.sendToMany(studentIds, notification);
        } catch (error) {
          logger.error("Send to course students error:", error);
        }
      },
    };

    // Generate email verification token
    function generateEmailVerificationToken(email) {
      return jwt.sign(
        { email, purpose: "email_verification" },
        process.env.JWT_SECRET,
        { expiresIn: "24h" },
      );
    }

    // Send verification email
    async function sendVerificationEmail(email, name, token) {
      const verificationUrl = `${process.env.FRONTEND_URL || "http://localhost:5173"}/verify-email?token=${token}`;

      const mailOptions = {
        from: `"BD Programming" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: "Verify Your Email Address - BD Programming",
        html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Verify Your Email</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
          .header h1 { color: white; margin: 0; }
          .content { background: #f9fafb; padding: 30px; border-radius: 0 0 10px 10px; }
          .button { display: inline-block; background: #6366f1; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; }
          .footer { text-align: center; padding: 20px; font-size: 12px; color: #6b7280; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Welcome to BD Programming!</h1>
          </div>
          <div class="content">
            <p>Hello <strong>${name}</strong>,</p>
            <p>Thank you for registering! Please verify your email address to get started.</p>
            <div style="text-align: center;">
              <a href="${verificationUrl}" class="button">Verify Email Address</a>
            </div>
            <p>Or copy and paste this link:</p>
            <p style="background: #e5e7eb; padding: 10px; border-radius: 5px; word-break: break-all;">${verificationUrl}</p>
            <p>This link expires in <strong>24 hours</strong>.</p>
            <p>If you didn't create an account, please ignore this email.</p>
          </div>
          <div class="footer">
            <p>© ${new Date().getFullYear()} BD Programming. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `,
      };

      return await transporter.sendMail(mailOptions);
    }

    api.post("/contact", async (req, res) => {
      try {
        logger.log("📝 Contact form submission received:", req.body);

        const { name, email, phone, subject, message, recaptchaToken } =
          req.body;

        // ===== 1. VALIDATION =====
        // Validate required fields
        if (!name || !email || !subject || !message) {
          return res.status(400).json({
            success: false,
            error: "Please fill all required fields",
          });
        }

        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
          return res.status(400).json({
            success: false,
            error: "Invalid email format",
          });
        }

        // ===== 2. RECAPTCHA VERIFICATION (Production only) =====
        if (process.env.NODE_ENV === "production") {
          if (!recaptchaToken) {
            return res.status(400).json({
              success: false,
              error: "reCAPTCHA verification required",
            });
          }

          const isRecaptchaValid = await verifyRecaptcha(recaptchaToken);
          if (!isRecaptchaValid) {
            return res.status(400).json({
              success: false,
              error: "reCAPTCHA verification failed. Please try again.",
            });
          }
        }

        // ===== 3. RATE LIMITING (Optional but recommended) =====
        const ip = req.ip || req.connection.remoteAddress;
        const rateLimitKey = `contact_${ip}`;

        if (!global.contactRateLimit) global.contactRateLimit = new Map();
        const now = Date.now();
        const userAttempts = global.contactRateLimit.get(rateLimitKey) || [];
        const recentAttempts = userAttempts.filter((t) => now - t < 3600000); // Last hour

        if (recentAttempts.length >= 5) {
          return res.status(429).json({
            success: false,
            error: "Too many messages. Please try again later.",
          });
        }

        recentAttempts.push(now);
        global.contactRateLimit.set(rateLimitKey, recentAttempts);

        // ===== 4. SAVE TO DATABASE =====
        const db = client.db("lmsDB");
        const contacts = db.collection("contacts");

        const contactData = {
          name,
          email,
          phone: phone || "",
          subject,
          message,
          status: "pending",
          createdAt: new Date(),
          userAgent: req.headers["user-agent"],
          ip: req.ip || req.connection.remoteAddress,
        };

        logger.log("💾 Saving to database:", contactData);
        const result = await contacts.insertOne(contactData);
        logger.log("✅ Saved with ID:", result.insertedId);

        // ===== 5. SEND EMAILS (Non-blocking) =====
        let emailSent = false;

        if (transporter && process.env.EMAIL_USER) {
          // Send acknowledgment email to user
          transporter
            .sendMail({
              from: `"BD Programming" <${process.env.EMAIL_USER}>`,
              to: email,
              subject: "Thank you for contacting BD Programming",
              html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <div style="background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
                <h1 style="color: white; margin: 0;">Thank You for Contacting Us!</h1>
              </div>
              <div style="background: #f9fafb; padding: 30px; border-radius: 0 0 10px 10px;">
                <p>Dear <strong>${name}</strong>,</p>
                <p>We have received your message and will get back to you within 24-48 hours.</p>
                <div style="background: #e5e7eb; padding: 15px; border-radius: 8px; margin: 20px 0;">
                  <p><strong>Subject:</strong> ${subject}</p>
                  <p><strong>Message:</strong> ${message}</p>
                </div>
                <p>In the meantime, you might find answers in our <a href="${process.env.FRONTEND_URL}/faq" style="color: #6366f1;">FAQ section</a>.</p>
                <p>Best regards,<br><strong>BD Programming Support Team</strong></p>
              </div>
              <div style="text-align: center; padding: 20px; font-size: 12px; color: #6b7280;">
                <p>© ${new Date().getFullYear()} BD Programming. All rights reserved.</p>
              </div>
            </div>
          `,
            })
            .then(() => {
              logger.log("✅ Acknowledgment email sent to user:", email);
              emailSent = true;
            })
            .catch((err) => logger.error("❌ Email error:", err.message));

          // Send admin notification
          transporter
            .sendMail({
              from: `"BD Programming Contact" <${process.env.EMAIL_USER}>`,
              to: process.env.ADMIN_EMAIL || "teams.rcsbd@gmail.com",
              subject: `New Contact Form Submission: ${subject}`,
              html: `
            <div style="font-family: Arial, sans-serif;">
              <h2 style="color: #6366f1;">New Contact Form Submission</h2>
              <table style="width: 100%; border-collapse: collapse;">
                <tr><td style="padding: 8px 0;"><strong>Name:</strong></td><td>${name}</td></tr>
                <tr><td style="padding: 8px 0;"><strong>Email:</strong></td><td>${email}</td></tr>
                <tr><td style="padding: 8px 0;"><strong>Phone:</strong></td><td>${phone || "Not provided"}</td></tr>
                <tr><td style="padding: 8px 0;"><strong>Subject:</strong></td><td>${subject}</td></tr>
                <tr><td style="padding: 8px 0;"><strong>Message:</strong></td><td>${message}</td></tr>
                <tr><td style="padding: 8px 0;"><strong>IP:</strong></td><td>${req.ip || "Not available"}</td></tr>
                <tr><td style="padding: 8px 0;"><strong>Time:</strong></td><td>${new Date().toLocaleString()}</td></tr>
              </table>
              <div style="margin-top: 20px;">
                <a href="${process.env.FRONTEND_URL}/admin/contacts/${result.insertedId}" style="background: #6366f1; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">View in Admin Panel</a>
              </div>
            </div>
          `,
            })
            .then(() => logger.log("✅ Admin notification email sent"))
            .catch((err) => logger.error("❌ Admin email error:", err.message));
        } else {
          logger.warn(
            "⚠️ Email transporter not configured. Skipping email notifications.",
          );
        }

        // ===== 6. SUCCESS RESPONSE =====
        res.status(201).json({
          success: true,
          message:
            "Your message has been sent successfully! We'll get back to you within 24-48 hours.",
          contactId: result.insertedId,
          emailSent: emailSent,
        });
      } catch (error) {
        logger.error("❌ Contact form error:", error);
        res.status(500).json({
          success: false,
          error: "Failed to submit contact form. Please try again later.",
        });
      }
    });

    // Helper function to handle course completion (UPDATED WITH NOTIFICATION)
    async function handleCourseCompletion(userId, courseId) {
      const user = await userCollection.findOne({ _id: new ObjectId(userId) });
      const course = await courseCollection.findOne({
        _id: new ObjectId(courseId),
      });

      // Generate certificate
      const certificateId = `CERT-${Date.now()}-${userId.toString().slice(-4)}`;
      const certificateUrl = `/certificates/${certificateId}.pdf`;

      const certificate = {
        certificateId,
        userId: new ObjectId(userId),
        courseId: new ObjectId(courseId),
        studentName: user.name,
        courseName: course.title,
        issueDate: new Date(),
        completionDate: new Date(),
        grade: "A",
        percentage: 100,
        duration: course.duration,
        instructorName: "Mohammad Alauddin",
        certificateUrl,
        verificationHash: generateVerificationHash(),
        isVerified: true,
      };

      await certificateCollection.insertOne(certificate);

      // Update user's enrollment
      await userCollection.updateOne(
        {
          _id: new ObjectId(userId),
          "enrolledCourses.courseId": new ObjectId(courseId),
        },
        {
          $set: {
            "enrolledCourses.$.status": "completed",
            "enrolledCourses.$.endDate": new Date(),
            "enrolledCourses.$.certificate": {
              issued: true,
              issueDate: new Date(),
              certificateUrl,
              certificateId,
            },
          },
        },
      );

      // ===== ENHANCED NOTIFICATION =====
      await notificationService.sendToUser(userId, {
        type: "achievement",
        message: `🏆 Congratulations! You've completed '${course.title}'`,
        details: "Your certificate is now available in your profile",
        actionUrl: "/certificates",
      });

      return certificate;
    }

    // Helper function to get lesson IDs for a course
    async function getLessonIds(courseId) {
      const chapters = await chapterCollection
        .find({ courseId: new ObjectId(courseId) })
        .toArray();

      const lessons = await lessonCollection
        .find({ chapterId: { $in: chapters.map((c) => c._id) } })
        .toArray();

      return lessons.map((l) => l._id);
    }

    // 7. GET user statistics for dashboard (FIXED WITH ERROR HANDLING)
    // ============= FIXED USER STATS ROUTE =============
    api.get(
      "/admin/users/stats",
      authenticateToken,
      isAdmin,
      async (req, res) => {
        try {
          logger.log("📊 Fetching user statistics...");

          // Verify userCollection exists
          if (!userCollection) {
            logger.error("❌ userCollection is not defined!");
            return res.status(500).json({
              success: false,
              message: "Database collection not initialized",
            });
          }

          // Get total users count
          const totalUsers = await userCollection.countDocuments();
          logger.log(`✅ Total users found: ${totalUsers}`);

          // Get counts by status
          let activeUsers = 0,
            suspendedUsers = 0,
            blockedUsers = 0,
            inactiveUsers = 0;

          try {
            activeUsers =
              (await userCollection.countDocuments({ status: "active" })) || 0;
            suspendedUsers =
              (await userCollection.countDocuments({ status: "suspended" })) ||
              0;
            blockedUsers =
              (await userCollection.countDocuments({ status: "blocked" })) || 0;
            inactiveUsers =
              (await userCollection.countDocuments({ status: "inactive" })) ||
              0;
          } catch (statusError) {
            logger.log("⚠️ Status field may not exist, using defaults");
            activeUsers = totalUsers;
          }

          // Get counts by role
          let adminCount = 0,
            instructorCount = 0,
            studentCount = 0;

          try {
            adminCount =
              (await userCollection.countDocuments({ role: "admin" })) || 0;
            instructorCount =
              (await userCollection.countDocuments({ role: "instructor" })) ||
              0;
            studentCount =
              (await userCollection.countDocuments({ role: "student" })) || 0;
          } catch (roleError) {
            logger.log("⚠️ Role field may not exist");
          }

          const stats = {
            total: totalUsers,
            active: activeUsers,
            suspended: suspendedUsers,
            blocked: blockedUsers,
            inactive: inactiveUsers,
            byRole: [
              { _id: "admin", count: adminCount },
              { _id: "instructor", count: instructorCount },
              { _id: "student", count: studentCount },
            ],
          };

          logger.log("✅ Stats calculated:", stats);

          res.json({
            success: true,
            stats: stats,
          });
        } catch (error) {
          logger.error("❌ Get user stats error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to fetch user statistics",
            error:
              process.env.NODE_ENV === "development"
                ? error.message
                : undefined,
          });
        }
      },
    );

    // ============= GET ALL USERS WITH STATS =============
    api.get("/admin/users", authenticateToken, isAdmin, async (req, res) => {
      try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;
        const { role, status, search } = req.query;

        // Build filter query
        let query = {};
        if (role && role !== "all") query.role = role;
        if (status && status !== "all") query.status = status;
        if (search) {
          query.$or = [
            { name: { $regex: search, $options: "i" } },
            { email: { $regex: search, $options: "i" } },
            { uniqueId: { $regex: search, $options: "i" } },
          ];
        }

        logger.log("🔍 Fetching users with query:", JSON.stringify(query));

        // Get total count for pagination
        const total = await userCollection.countDocuments(query);

        // Get users with selected fields only
        const users = await userCollection
          .find(query, {
            projection: {
              password: 0,
              notifications: 0,
              settings: 0,
            },
          })
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .toArray();

        logger.log(`✅ Found ${users.length} users`);

        // Get enrollment and payment stats for each user
        const usersWithStats = await Promise.all(
          users.map(async (user) => {
            // Ensure status field exists
            if (!user.status) {
              user.status = "active";
            }

            // Get enrolled courses count
            const enrolledCount = user.enrolledCourses?.length || 0;

            // Get completed courses count
            const completedCount =
              user.enrolledCourses?.filter((c) => c && c.status === "completed")
                .length || 0;

            // Get payment count
            let payments = 0;
            try {
              payments =
                (await paymentCollection.countDocuments({
                  userId: user._id,
                  status: "COMPLETED",
                })) || 0;
            } catch (e) {
              logger.log(
                `No payment collection or no payments for user ${user._id}`,
              );
            }

            return {
              ...user,
              stats: {
                enrolledCourses: enrolledCount,
                completedCourses: completedCount,
                totalPayments: payments,
              },
            };
          }),
        );

        res.json({
          success: true,
          users: usersWithStats,
          pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit),
          },
        });
      } catch (error) {
        logger.error("❌ Get users error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch users",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // 6. BULK user operations
    api.post(
      "/admin/users/bulk-action",
      authenticateToken,
      isAdmin,
      async (req, res) => {
        try {
          const { action, userIds, data } = req.body;

          if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
            return res.status(400).json({
              success: false,
              message: "No users selected",
            });
          }

          const objectIds = userIds.map((id) => new ObjectId(id));

          let result;
          switch (action) {
            case "delete":
              result = await userCollection.deleteMany({
                _id: { $in: objectIds },
              });
              break;

            case "changeRole":
              if (!data?.role) {
                return res.status(400).json({
                  success: false,
                  message: "Role is required",
                });
              }
              result = await userCollection.updateMany(
                { _id: { $in: objectIds } },
                { $set: { role: data.role, updatedAt: new Date() } },
              );
              break;

            case "changeStatus":
              if (!data?.status) {
                return res.status(400).json({
                  success: false,
                  message: "Status is required",
                });
              }
              result = await userCollection.updateMany(
                { _id: { $in: objectIds } },
                { $set: { status: data.status, updatedAt: new Date() } },
              );
              break;

            default:
              return res.status(400).json({
                success: false,
                message: "Invalid action",
              });
          }

          res.json({
            success: true,
            message: `Bulk action completed: ${result.modifiedCount} users affected`,
            modifiedCount: result.modifiedCount,
          });
        } catch (error) {
          logger.error("Bulk action error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to perform bulk action",
          });
        }
      },
    );

    // ============= ADD EMAIL LOGS ROUTE (Admin only) =============
    api.get("/admin/email-logs", authenticateToken, async (req, res) => {
      try {
        // Check if user is admin
        const user = await userCollection.findOne({
          _id: new ObjectId(req.user.userId),
        });
        if (user.role !== "admin") {
          return res
            .status(403)
            .json({ success: false, message: "Admin access required" });
        }

        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const skip = (page - 1) * limit;

        const logs = await emailLogCollection
          .find({})
          .sort({ sentAt: -1 })
          .skip(skip)
          .limit(limit)
          .toArray();

        const total = await emailLogCollection.countDocuments();

        res.json({
          success: true,
          logs,
          pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit),
          },
        });
      } catch (error) {
        logger.error("Get email logs error:", error);
        res
          .status(500)
          .json({ success: false, message: "Failed to get email logs" });
      }
    });

    // ============= ADMIN USER MANAGEMENT ROUTES =============
    // 2. GET single user details with full info
    api.get(
      "/admin/users/:userId",
      authenticateToken,
      isAdmin,
      async (req, res) => {
        try {
          const { userId } = req.params;

          logger.log("🔍 Fetching user details for ID:", userId);

          // Validate if userId is a valid ObjectId
          if (!ObjectId.isValid(userId)) {
            logger.log("❌ Invalid user ID format:", userId);
            return res.status(400).json({
              success: false,
              message: "Invalid user ID format",
            });
          }

          const user = await userCollection.findOne(
            { _id: new ObjectId(userId) },
            { projection: { password: 0 } },
          );

          if (!user) {
            return res.status(404).json({
              success: false,
              message: "User not found",
            });
          }

          // Get user's payments
          const payments = await paymentCollection
            .find({ userId: new ObjectId(userId) })
            .sort({ createdAt: -1 })
            .toArray();

          // Get user's enrolled courses with details
          const enrolledCourses = await Promise.all(
            (user.enrolledCourses || []).map(async (enrollment) => {
              const course = await courseCollection.findOne(
                { _id: enrollment.courseId },
                { projection: { title: 1, thumbnail: 1, price: 1 } },
              );
              return {
                ...enrollment,
                courseDetails: course,
              };
            }),
          );

          res.json({
            success: true,
            user: {
              ...user,
              payments,
              enrolledCourses,
            },
          });
        } catch (error) {
          logger.error("Get user details error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to fetch user details",
            error:
              process.env.NODE_ENV === "development"
                ? error.message
                : undefined,
          });
        }
      },
    );

    // 3. UPDATE user role
    api.put(
      "/admin/users/:userId/role",
      authenticateToken,
      isAdmin,
      async (req, res) => {
        try {
          const { userId } = req.params;
          const { role } = req.body;

          if (!["student", "instructor", "admin"].includes(role)) {
            return res.status(400).json({
              success: false,
              message: "Invalid role",
            });
          }

          const result = await userCollection.updateOne(
            { _id: new ObjectId(userId) },
            {
              $set: {
                role,
                updatedAt: new Date(),
              },
            },
          );

          if (result.matchedCount === 0) {
            return res.status(404).json({
              success: false,
              message: "User not found",
            });
          }

          // Log the action
          logger.log(
            `User ${userId} role changed to ${role} by admin ${req.user.userId}`,
          );

          res.json({
            success: true,
            message: "User role updated successfully",
          });
        } catch (error) {
          logger.error("Update user role error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to update user role",
          });
        }
      },
    );

    // 4. UPDATE user status (active/suspended/blocked)
    api.put(
      "/admin/users/:userId/status",
      authenticateToken,
      isAdmin,
      async (req, res) => {
        try {
          const { userId } = req.params;
          const { status } = req.body;

          if (
            !["active", "suspended", "blocked", "inactive"].includes(status)
          ) {
            return res.status(400).json({
              success: false,
              message: "Invalid status",
            });
          }

          const result = await userCollection.updateOne(
            { _id: new ObjectId(userId) },
            {
              $set: {
                status,
                updatedAt: new Date(),
                ...(status === "blocked" ? { blockedAt: new Date() } : {}),
              },
            },
          );

          if (result.matchedCount === 0) {
            return res.status(404).json({
              success: false,
              message: "User not found",
            });
          }

          res.json({
            success: true,
            message: `User ${status} successfully`,
          });
        } catch (error) {
          logger.error("Update user status error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to update user status",
          });
        }
      },
    );

    // 5. DELETE user (cascade delete)
    api.delete(
      "/admin/users/:userId",
      authenticateToken,
      isAdmin,
      async (req, res) => {
        try {
          const { userId } = req.params;

          // Start a session for transaction
          const session = client.startSession();

          try {
            await session.withTransaction(async () => {
              // Get user first to find related data
              const user = await userCollection.findOne({
                _id: new ObjectId(userId),
              });

              if (!user) {
                throw new Error("User not found");
              }

              // 1. Delete user's payments
              await paymentCollection.deleteMany(
                { userId: new ObjectId(userId) },
                { session },
              );

              // 2. Delete user's certificates
              await certificateCollection.deleteMany(
                { userId: new ObjectId(userId) },
                { session },
              );

              // 3. Remove user from any course analytics (optional)
              // ... any other cleanup

              // 4. Finally delete the user
              await userCollection.deleteOne(
                { _id: new ObjectId(userId) },
                { session },
              );

              logger.log(
                `User ${userId} and all related data deleted by admin ${req.user.userId}`,
              );
            });

            // await session.commitTransaction();

            res.json({
              success: true,
              message: "User and all related data deleted successfully",
            });
          } finally {
            await session.endSession();
          }
        } catch (error) {
          logger.error("Delete user error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to delete user",
          });
        }
      },
    );

    // Get user's testimonials (for profile page)
    api.get(
      "/users/:userId/testimonials",
      authenticateToken,
      async (req, res) => {
        try {
          const { userId } = req.params;
          const requestingUserId = req.user.userId;

          logger.log("📝 Fetching testimonials for userId:", userId);
          logger.log("🔐 Requesting userId:", requestingUserId);

          // Users can only see their own testimonials (or admin can see all)
          if (userId !== requestingUserId && req.user.role !== "admin") {
            logger.log("❌ Unauthorized access attempt");
            return res.status(403).json({
              success: false,
              message: "Unauthorized to view these testimonials",
            });
          }

          // Find testimonials for this user
          const testimonials = await testimonialCollection
            .find({ userId: new ObjectId(userId) })
            .sort({ createdAt: -1 })
            .toArray();

          logger.log(
            `✅ Found ${testimonials.length} testimonials for user ${userId}`,
          );
          logger.log(
            "📊 Testimonials data:",
            JSON.stringify(testimonials, null, 2),
          );

          res.json({
            success: true,
            testimonials: testimonials,
            count: testimonials.length,
          });
        } catch (error) {
          logger.error("❌ Get user testimonials error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to fetch testimonials",
            error:
              process.env.NODE_ENV === "development"
                ? error.message
                : undefined,
          });
        }
      },
    );

    // ============= AUTH ROUTES =============
    // Register new user
    // ============= PRODUCTION READY REGISTRATION ENDPOINT =============

    api.post("/register", async (req, res) => {
      try {
        const {
          name,
          email,
          password,
          // role = "student",
          recaptchaToken,
        } = req.body;

        logger.log("📝 Registration attempt for:", email);

        // ===== 1. INPUT VALIDATION =====
        if (!name || !email || !password) {
          return res.status(400).json({
            success: false,
            message: "Name, email, and password are required",
          });
        }

        // Email format validation
        const emailRegex = /^[^\s@]+@([^\s@.,]+\.)+[^\s@.,]{2,}$/;
        if (!emailRegex.test(email)) {
          return res.status(400).json({
            success: false,
            message: "Invalid email format",
          });
        }

        // Block disposable email domains
        const domain = email.split("@")[1];
        const disposableDomains = [
          "tempmail.com",
          "throwaway.com",
          "mailinator.com",
          "10minutemail.com",
          "guerrillamail.com",
          "sharklasers.com",
        ];
        if (disposableDomains.includes(domain)) {
          return res.status(400).json({
            success: false,
            message: "Please use a permanent email address",
          });
        }

        // ===== 2. PASSWORD VALIDATION (Consistent with frontend) =====
        const passwordErrors = [];
        if (password.length < 8) passwordErrors.push("at least 8 characters");
        if (!/[A-Z]/.test(password)) passwordErrors.push("an uppercase letter");
        if (!/[a-z]/.test(password)) passwordErrors.push("a lowercase letter");
        if (!/[0-9]/.test(password)) passwordErrors.push("a number");
        if (!/[!@#$%^&*]/.test(password))
          passwordErrors.push("a special character (!@#$%^&*)");

        if (passwordErrors.length > 0) {
          return res.status(400).json({
            success: false,
            message: `Password must contain: ${passwordErrors.join(", ")}`,
          });
        }

        // ===== 3. RATE LIMITING (IP-based) =====
        const ip = req.ip || req.connection.remoteAddress;
        const rateLimitKey = `register_${ip}`;

        // Simple in-memory rate limiting (use Redis in production)
        if (!global.rateLimitStore) global.rateLimitStore = new Map();
        const now = Date.now();
        const userAttempts = global.rateLimitStore.get(rateLimitKey) || [];
        const recentAttempts = userAttempts.filter((t) => now - t < 3600000); // Last hour

        if (recentAttempts.length >= 5) {
          return res.status(429).json({
            success: false,
            message: "Too many registration attempts. Please try again later.",
          });
        }

        recentAttempts.push(now);
        global.rateLimitStore.set(rateLimitKey, recentAttempts);

        // ===== 4. CHECK PWNED PASSWORDS =====
        const isPwned = await isPasswordPwned(password);
        if (isPwned) {
          return res.status(400).json({
            success: false,
            message:
              "This password has been exposed in data breaches. Please choose a different password.",
          });
        }

        // ===== 5. RECAPTCHA VERIFICATION (Required in production) =====
        if (process.env.NODE_ENV === "production") {
          if (!recaptchaToken) {
            return res.status(400).json({
              success: false,
              message: "reCAPTCHA verification required",
            });
          }

          const isRecaptchaValid = await verifyRecaptcha(recaptchaToken);
          if (!isRecaptchaValid) {
            return res.status(400).json({
              success: false,
              message: "reCAPTCHA verification failed. Please try again.",
            });
          }
        }

        // ===== 6. CHECK IF USER EXISTS (Security: Don't reveal email existence) =====
        const existingUser = await userCollection.findOne({
          email: email.toLowerCase(),
        });
        if (existingUser) {
          // Return generic message for security
          return res.status(400).json({
            success: false,
            message: "Unable to create account. Please check your information.",
          });
        }

        // ===== 7. CREATE USER =====
        const hashedPassword = await bcrypt.hash(password, 12); // Increased cost factor
        const uniqueId = await generateUniqueStudentId();

        // Sanitize name (XSS protection)
        const sanitizedName = name.trim().replace(/[<>]/g, "").slice(0, 100);

        // Generate verification token
        const verificationToken = generateEmailVerificationToken(email);

        const userData = {
          uniqueId,
          name: sanitizedName,
          email: email.toLowerCase().trim(),
          password: hashedPassword,
          role: "student",
          isEmailVerified: false,
          emailVerificationToken: verificationToken,
          emailVerificationExpires: new Date(Date.now() + 24 * 60 * 60 * 1000),
          profile: {
            phone: "",
            bio: "",
            address: {
              street: "",
              city: "",
              state: "",
              country: "",
              zipCode: "",
            },
            education: {
              highestDegree: "",
              institution: "",
              yearOfPassing: "",
              specialization: "",
            },
            socialLinks: { github: "", linkedin: "", twitter: "" },
          },
          enrolledCourses: [],
          wishlist: [],
          notifications: [],
          settings: {
            profile: {
              name: sanitizedName,
              email: email.toLowerCase(),
              phone: "",
              bio: "",
              language: "en",
              timezone: "UTC",
            },
            notifications: {
              emailNotifications: true,
              pushNotifications: true,
              courseUpdates: true,
              newLessons: true,
              achievements: true,
              newsletters: false,
              marketingEmails: false,
            },
            privacy: {
              profileVisibility: "public",
              showProgress: true,
              showCertificates: true,
              allowMessages: true,
            },
            security: {
              twoFactorAuth: false,
              loginAlerts: true,
              sessionTimeout: 30,
            },
            appearance: {
              theme: "light",
              compactMode: false,
              fontSize: "medium",
              reducedMotion: false,
            },
          },
          createdAt: new Date(),
          updatedAt: new Date(),
          lastLogin: null,
          status: "pending_verification",
        };

        const result = await userCollection.insertOne(userData);

        // ===== 8. SEND VERIFICATION EMAIL =====
        try {
          await sendVerificationEmail(email, sanitizedName, verificationToken);
          logger.log("✅ Verification email sent to:", email);
        } catch (emailError) {
          logger.error("❌ Failed to send verification email:", emailError);
          // Don't fail registration, but log error
        }

        // ===== 9. AUDIT LOG =====
        logger.log(`✅ User registered: ${email} (ID: ${result.insertedId})`);

        // ===== 10. RESPONSE (No auto-login, requires verification) =====
        res.status(201).json({
          success: true,
          message:
            "Registration successful! Please check your email to verify your account.",
          requiresVerification: true,
          email: userData.email,
        });
      } catch (error) {
        logger.error("❌ Registration error:", error);
        res.status(500).json({
          success: false,
          message: "Registration failed. Please try again later.",
        });
      }
    });

    // verify-email endpoint:

    api.get("/verify-email", async (req, res) => {
      try {
        const { token } = req.query;

        logger.log("📧 Email verification request received");

        // ===== 1. VALIDATE TOKEN EXISTENCE =====
        if (!token) {
          return res.status(400).json({
            success: false,
            message: "Verification token required",
          });
        }

        // ===== 2. VERIFY JWT TOKEN =====
        let decoded;

        try {
          decoded = jwt.verify(token, process.env.JWT_SECRET);
        } catch (err) {
          logger.warn("❌ Invalid verification token");

          return res.status(400).json({
            success: false,
            message: "Invalid or expired verification token",
          });
        }

        // ===== 3. VALIDATE TOKEN PURPOSE =====
        if (decoded.purpose !== "email_verification") {
          logger.warn("❌ Invalid token purpose");

          return res.status(400).json({
            success: false,
            message: "Invalid token type",
          });
        }

        const email = decoded.email.toLowerCase().trim();

        logger.log("✅ Verification token validated");

        // ===== 4. FIND USER =====
        const user = await userCollection.findOne({
          email,
          emailVerificationToken: token,
          emailVerificationExpires: {
            $gt: new Date(),
          },
        });

        if (!user) {
          logger.warn(
            "❌ Verification failed: user not found or token expired",
          );

          return res.status(400).json({
            success: false,
            message: "Invalid or expired verification token",
          });
        }

        // ===== 5. PREVENT DOUBLE VERIFICATION =====
        if (user.isEmailVerified) {
          return res.status(400).json({
            success: false,
            message: "Email already verified",
          });
        }

        // ===== 6. UPDATE USER =====
        await userCollection.updateOne(
          { _id: user._id },
          {
            $set: {
              isEmailVerified: true,
              status: "active",
              emailVerifiedAt: new Date(),
              updatedAt: new Date(),
            },
            $unset: {
              emailVerificationToken: "",
              emailVerificationExpires: "",
            },
          },
        );

        logger.log("✅ Email verified successfully");

        // ===== 7. SUCCESS RESPONSE =====
        res.status(200).json({
          success: true,
          message: "Email verified successfully! You can now log in.",
        });
      } catch (error) {
        logger.error("❌ Email verification error:", error);

        res.status(500).json({
          success: false,
          message: "Server error during verification",
        });
      }
    });

    // Add this endpoint after your registration endpoint
    api.post("/resend-verification", async (req, res) => {
      try {
        const { email } = req.body;

        logger.log("📧 Resend verification requested for:", email);

        if (!email) {
          return res.status(400).json({
            success: false,
            message: "Email is required",
          });
        }

        // Find user
        const user = await userCollection.findOne({
          email: email.toLowerCase(),
        });

        if (!user) {
          return res.status(404).json({
            success: false,
            message: "User not found",
          });
        }

        // Check if already verified
        if (user.isEmailVerified) {
          return res.status(400).json({
            success: false,
            message: "Email already verified",
          });
        }

        // Rate limiting for resend (prevent spam)
        const lastSent = user.lastVerificationSent;
        if (lastSent) {
          const minutesSinceLastSent =
            (Date.now() - new Date(lastSent)) / 60000;
          if (minutesSinceLastSent < 5) {
            return res.status(429).json({
              success: false,
              message: `Please wait ${Math.ceil(5 - minutesSinceLastSent)} minutes before requesting another email`,
              retryAfter: Math.ceil(5 - minutesSinceLastSent),
            });
          }
        }

        // Generate new verification token
        const verificationToken = generateEmailVerificationToken(email);

        // Send verification email
        await sendVerificationEmail(email, user.name, verificationToken);

        // Update user with new token
        await userCollection.updateOne(
          { _id: user._id },
          {
            $set: {
              emailVerificationToken: verificationToken,
              emailVerificationExpires: new Date(
                Date.now() + 24 * 60 * 60 * 1000,
              ),
              lastVerificationSent: new Date(),
            },
          },
        );

        logger.log("✅ Verification email resent to:", email);

        res.json({
          success: true,
          message: "Verification email sent successfully",
        });
      } catch (error) {
        logger.error("❌ Resend verification error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to send verification email",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // Login
    // ============= UPDATED LOGIN ENDPOINT (With verification check) =============

    api.post("/login", async (req, res) => {
      try {
        const { email, password } = req.body;

        const ip = req.ip || req.connection.remoteAddress;

        // Validate input first
        if (!email || !password) {
          return res.status(400).json({
            success: false,
            message: "Email and password are required",
          });
        }

        // Normalize email
        const normalizedEmail = email.toLowerCase().trim();

        // Check brute-force protection
        const loginCheck = checkLoginAttempts(ip, normalizedEmail);

        if (loginCheck.blocked) {
          return res.status(429).json({
            success: false,
            message: `Too many failed login attempts. Try again in ${loginCheck.remainingTime} minutes.`,
          });
        }

        // Find user
        const user = await userCollection.findOne({
          email: normalizedEmail,
        });

        // User not found
        if (!user) {
          recordFailedLogin(ip, normalizedEmail);

          return res.status(401).json({
            success: false,
            message: "Invalid credentials",
          });
        }

        // Check if email verified
        if (!user.isEmailVerified) {
          return res.status(403).json({
            success: false,
            message: "Please verify your email before logging in",
            requiresVerification: true,
            email: user.email,
          });
        }

        // Check account status
        if (user.status === "blocked" || user.status === "suspended") {
          return res.status(403).json({
            success: false,
            message: "Your account has been suspended. Please contact support.",
          });
        }

        // Verify password
        const isValidPassword = await bcrypt.compare(password, user.password);

        if (!isValidPassword) {
          recordFailedLogin(ip, normalizedEmail);

          return res.status(401).json({
            success: false,
            message: "Invalid credentials",
          });
        }

        // Clear failed attempts after successful login
        clearLoginAttempts(ip, normalizedEmail);

        // Update last login
        await userCollection.updateOne(
          { _id: user._id },
          {
            $set: {
              lastLogin: new Date(),
            },
          },
        );

        // Generate JWT
        const token = jwt.sign(
          {
            userId: user._id,
            email: user.email,
            role: user.role,
            isVerified: user.isEmailVerified,
          },
          process.env.JWT_SECRET,
          {
            expiresIn: "7d",
          },
        );

        // Remove password from response
        const { password: _, ...userWithoutPassword } = user;

        res.json({
          success: true,
          message: "Login successful",
          token,
          user: userWithoutPassword,
        });
      } catch (error) {
        logger.error("Login error:", error);

        res.status(500).json({
          success: false,
          message: "Login failed. Please try again.",
        });
      }
    });

    // ============= PASSWORD RESET WITH OTP =============
    // Request OTP for password reset
    api.post("/forgot-password", async (req, res) => {
      try {
        const { email } = req.body;

        const user = await userCollection.findOne({ email });
        if (!user) {
          return res
            .status(404)
            .json({ success: false, message: "User not found" });
        }

        // Generate OTP
        const otp = generateOTP();
        const expiresAt = new Date(Date.now() + 10 * 60000); // 10 minutes

        // Save OTP
        await otpCollection.insertOne({
          email,
          otp,
          purpose: "password_reset",
          expiresAt,
          attempts: 0,
          verified: false,
          createdAt: new Date(),
        });

        // Send email
        const mailOptions = {
          from: process.env.EMAIL_USER,
          to: email,
          subject: "Password Reset OTP - Reliable Code Solutions",
          html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #0D9488;">Password Reset Request</h2>
          <p>Hello ${user.name},</p>
          <p>You requested to reset your password. Use the following OTP to proceed:</p>
          <div style="background: #f3f4f6; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0;">
            <h1 style="font-size: 36px; letter-spacing: 5px; color: #0D9488;">${otp}</h1>
          </div>
          <p>This OTP will expire in 10 minutes.</p>
          <p>If you didn't request this, please ignore this email.</p>
          <hr style="border: 1px solid #e5e7eb; margin: 20px 0;">
          <p style="color: #6b7280; font-size: 12px;">BD Programming - Your Learning Partner</p>
        </div>
      `,
        };

        await transporter.sendMail(mailOptions);

        res.json({
          success: true,
          message: "OTP sent to your email",
          expiresIn: 600, // seconds
        });
      } catch (error) {
        logger.error("Forgot password error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to send OTP",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // Verify OTP
    api.post("/verify-otp", async (req, res) => {
      try {
        const { email, otp } = req.body;

        const otpRecord = await otpCollection.findOne({
          email,
          otp,
          purpose: "password_reset",
          expiresAt: { $gt: new Date() },
          verified: false,
        });

        if (!otpRecord) {
          return res
            .status(400)
            .json({ success: false, message: "Invalid or expired OTP" });
        }

        // Mark as verified
        await otpCollection.updateOne(
          { _id: otpRecord._id },
          { $set: { verified: true } },
        );

        // Generate temporary token for password reset
        const resetToken = jwt.sign(
          { email, purpose: "password_reset" },
          process.env.JWT_SECRET,
          { expiresIn: "10m" },
        );

        res.json({
          success: true,
          message: "OTP verified successfully",
          token: resetToken,
        });
      } catch (error) {
        logger.error("Verify OTP error:", error);
        res.status(500).json({
          success: false,
          message: "OTP verification failed",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // Reset password
    api.post("/reset-password", async (req, res) => {
      try {
        const { token, newPassword } = req.body;

        // ===== 1. VALIDATE INPUT =====
        if (!token || !newPassword) {
          return res.status(400).json({
            success: false,
            message: "Token and new password are required",
          });
        }

        // ===== 2. PASSWORD VALIDATION =====
        const passwordErrors = [];

        if (newPassword.length < 8) {
          passwordErrors.push("at least 8 characters");
        }

        if (!/[A-Z]/.test(newPassword)) {
          passwordErrors.push("an uppercase letter");
        }

        if (!/[a-z]/.test(newPassword)) {
          passwordErrors.push("a lowercase letter");
        }

        if (!/[0-9]/.test(newPassword)) {
          passwordErrors.push("a number");
        }

        if (!/[!@#$%^&*]/.test(newPassword)) {
          passwordErrors.push("a special character (!@#$%^&*)");
        }

        if (passwordErrors.length > 0) {
          return res.status(400).json({
            success: false,
            message: `Password must contain: ${passwordErrors.join(", ")}`,
          });
        }

        // ===== 3. CHECK PWNED PASSWORDS =====
        const isPwned = await isPasswordPwned(newPassword);

        if (isPwned) {
          return res.status(400).json({
            success: false,
            message:
              "This password has been exposed in data breaches. Please choose a different password.",
          });
        }

        // ===== 4. VERIFY TOKEN =====
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        if (!decoded || decoded.purpose !== "password_reset") {
          return res.status(401).json({
            success: false,
            message: "Invalid or expired token",
          });
        }

        // ===== 5. HASH PASSWORD =====
        const hashedPassword = await bcrypt.hash(newPassword, 12);

        // ===== 6. UPDATE PASSWORD =====
        await userCollection.updateOne(
          { email: decoded.email },
          {
            $set: {
              password: hashedPassword,
              updatedAt: new Date(),
            },
          },
        );

        // ===== 7. CLEAR USED OTPs =====
        await otpCollection.deleteMany({
          email: decoded.email,
          purpose: "password_reset",
        });

        logger.log(`✅ Password reset successful for: ${decoded.email}`);

        // ===== 8. SUCCESS RESPONSE =====
        res.json({
          success: true,
          message: "Password reset successfully",
        });
      } catch (error) {
        logger.error("Reset password error:", error);

        // Handle JWT expiration specifically
        if (
          error.name === "TokenExpiredError" ||
          error.name === "JsonWebTokenError"
        ) {
          return res.status(401).json({
            success: false,
            message: "Invalid or expired reset token",
          });
        }

        res.status(500).json({
          success: false,
          message: "Failed to reset password",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // ============= USER PROFILE ROUTES =============
    // Get user profile
    api.get("/users/profile", authenticateToken, async (req, res) => {
      try {
        const userId = req.user.userId;

        logger.log("📋 Fetching profile for user:", userId);

        // Validate userId
        if (!ObjectId.isValid(userId)) {
          return res.status(400).json({
            success: false,
            message: "Invalid user ID format",
          });
        }

        // Use projection to only get needed fields
        const user = await userCollection.findOne(
          { _id: new ObjectId(userId) },
          {
            projection: {
              password: 0,
              notifications: 0,
              // Add other fields you don't need in profile
            },
          },
        );

        if (!user) {
          return res.status(404).json({
            success: false,
            message: "User not found",
          });
        }

        logger.log("✅ Profile fetched successfully for:", user.email);

        res.json({
          success: true,
          user: {
            ...user,
            // Ensure these fields exist
            name: user.name || "",
            email: user.email || "",
            role: user.role || "student",
            uniqueId: user.uniqueId || "",
            profile: user.profile || {},
            enrolledCourses: user.enrolledCourses || [],
            wishlist: user.wishlist || [],
            settings: user.settings || {},
            createdAt: user.createdAt,
            lastLogin: user.lastLogin,
          },
        });
      } catch (error) {
        logger.error("❌ Get profile error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch profile",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // Update user profile
    api.put("/users/profile", authenticateToken, async (req, res) => {
      try {
        const { name, profile } = req.body;

        const updateData = {
          ...(name && { name }),
          ...(profile && { profile }),
          updatedAt: new Date(),
        };

        await userCollection.updateOne(
          { _id: new ObjectId(req.user.userId) },
          { $set: updateData },
        );

        res.json({
          success: true,
          message: "Profile updated successfully",
        });
      } catch (error) {
        logger.error("Update profile error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to update profile",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // ============= COURSE ENROLLMENT ROUTES =============
    function parseDurationToDays(duration) {
      if (!duration) return 90; // Default 90 days

      const durationStr = duration.toLowerCase();
      const number = parseInt(durationStr);

      if (durationStr.includes("month")) {
        return number * 30; // Convert months to days
      } else if (durationStr.includes("week")) {
        return number * 7;
      } else if (durationStr.includes("day")) {
        return number;
      } else if (durationStr.includes("year")) {
        return number * 365;
      }

      return 90; // Default fallback
    }

    // In your enrollment route (when student enrolls)
    api.post("/users/enroll/:courseId", authenticateToken, async (req, res) => {
      try {
        const { courseId } = req.params;
        const userId = req.user.userId;

        // ... existing enrollment code ...

        // AFTER successful enrollment, update course stats
        await courseCollection.updateOne(
          { _id: new ObjectId(courseId) },
          { $inc: { "stats.totalStudents": 1 } },
        );

        // Also update instructor's studentsTaught count
        const course = await courseCollection.findOne({
          _id: new ObjectId(courseId),
        });
        if (course.instructor?._id) {
          await userCollection.updateOne(
            { _id: course.instructor._id },
            { $inc: { studentsTaught: 1 } },
          );
        }

        res.json({ success: true, message: "Enrolled successfully" });
      } catch (error) {
        logger.error("Enrollment error:", error);
        res.status(500).json({
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // Update course progress
    api.post(
      "/users/progress/:courseId",
      authenticateToken,
      async (req, res) => {
        try {
          const { courseId } = req.params;
          const { lessonId, topicId, chapterId, timeSpent } = req.body;
          const userId = req.user.userId;

          const user = await userCollection.findOne({
            _id: new ObjectId(userId),
            "enrolledCourses.courseId": new ObjectId(courseId),
          });

          if (!user) {
            return res
              .status(404)
              .json({ success: false, message: "Enrollment not found" });
          }

          const enrollment = user.enrolledCourses.find(
            (e) => e.courseId.toString() === courseId,
          );

          // Update completed items
          const completedChapters = [
            ...(enrollment.progress.completedChapters || []),
          ];
          const completedLessons = [
            ...(enrollment.progress.completedLessons || []),
          ];
          const completedTopics = [
            ...(enrollment.progress.completedTopics || []),
          ];

          if (topicId && !completedTopics.includes(topicId)) {
            completedTopics.push(new ObjectId(topicId));
          }
          if (lessonId && !completedLessons.includes(lessonId)) {
            completedLessons.push(new ObjectId(lessonId));
          }
          if (chapterId && !completedChapters.includes(chapterId)) {
            completedChapters.push(new ObjectId(chapterId));
          }

          // Calculate overall progress
          const lessonIds = await getLessonIds(courseId);
          const totalTopics = await topicCollection.countDocuments({
            lessonId: { $in: lessonIds },
          });
          const progressPercentage =
            totalTopics > 0
              ? Math.round((completedTopics.length / totalTopics) * 100)
              : 0;

          await userCollection.updateOne(
            {
              _id: new ObjectId(userId),
              "enrolledCourses.courseId": new ObjectId(courseId),
            },
            {
              $set: {
                "enrolledCourses.$.progress.overall": progressPercentage,
                "enrolledCourses.$.progress.completedChapters":
                  completedChapters,
                "enrolledCourses.$.progress.completedLessons": completedLessons,
                "enrolledCourses.$.progress.completedTopics": completedTopics,
                "enrolledCourses.$.progress.lastAccessed": new Date(),
                "enrolledCourses.$.progress.timeSpent":
                  (enrollment.progress.timeSpent || 0) + (timeSpent || 0),
              },
            },
          );

          // Check if course completed
          if (progressPercentage === 100) {
            const certificate = await handleCourseCompletion(userId, courseId);
            return res.json({
              success: true,
              message: "Congratulations! Course completed!",
              progress: progressPercentage,
              certificate,
            });
          }

          res.json({
            success: true,
            message: "Progress updated",
            progress: progressPercentage,
          });
        } catch (error) {
          logger.error("Progress update error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to update progress",
            error:
              process.env.NODE_ENV === "development"
                ? error.message
                : undefined,
          });
        }
      },
    );

    // Get user's enrolled courses with progress
    api.get("/users/my-courses", authenticateToken, async (req, res) => {
      try {
        const user = await userCollection.findOne(
          { _id: new ObjectId(req.user.userId) },
          { projection: { enrolledCourses: 1 } },
        );

        // Get full course details for each enrollment
        const coursesWithProgress = await Promise.all(
          (user.enrolledCourses || []).map(async (enrollment) => {
            const course = await courseCollection.findOne(
              { _id: enrollment.courseId },
              {
                projection: {
                  title: 1,
                  description: 1,
                  thumbnail: 1,
                  level: 1,
                  duration: 1,
                  slug: 1,
                  totalChapters: 1,
                  totalLessons: 1,
                  totalTopics: 1,
                },
              },
            );

            if (!course) return null;

            return {
              ...course,
              enrollment: enrollment,
              _id: course._id, // Make sure ID is included
            };
          }),
        );

        // Filter out any null values (courses that might have been deleted)
        const validCourses = coursesWithProgress.filter((c) => c !== null);

        res.json({
          success: true,
          courses: validCourses,
        });
      } catch (error) {
        logger.error("Get my courses error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch courses",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // Get user's certificates
    api.get("/users/certificates", authenticateToken, async (req, res) => {
      try {
        const certificates = await certificateCollection
          .find({ userId: new ObjectId(req.user.userId) })
          .sort({ issueDate: -1 })
          .toArray();

        res.json({
          success: true,
          certificates,
        });
      } catch (error) {
        logger.error("Get certificates error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch certificates",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // Verify certificate
    api.get("/certificates/verify/:certificateId", async (req, res) => {
      try {
        const { certificateId } = req.params;

        const certificate = await certificateCollection.findOne({
          certificateId,
        });

        if (!certificate) {
          return res.status(404).json({
            success: false,
            message: "Certificate not found",
          });
        }

        res.json({
          success: true,
          certificate: {
            studentName: certificate.studentName,
            courseName: certificate.courseName,
            issueDate: certificate.issueDate,
            isVerified: certificate.isVerified,
          },
        });
      } catch (error) {
        logger.error("Verify certificate error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to verify certificate",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // Add to wishlist
    api.post(
      "/users/wishlist/:courseId",
      authenticateToken,
      async (req, res) => {
        try {
          const { courseId } = req.params;
          const userId = req.user.userId;

          // Check if course exists
          const course = await courseCollection.findOne({
            _id: new ObjectId(courseId),
          });

          if (!course) {
            return res
              .status(404)
              .json({ success: false, message: "Course not found" });
          }

          await userCollection.updateOne(
            { _id: new ObjectId(userId) },
            { $addToSet: { wishlist: new ObjectId(courseId) } },
          );

          res.json({
            success: true,
            message: "Course added to wishlist",
          });
        } catch (error) {
          logger.error("Wishlist error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to add to wishlist",
            error:
              process.env.NODE_ENV === "development"
                ? error.message
                : undefined,
          });
        }
      },
    );

    // Remove from wishlist
    api.delete(
      "/users/wishlist/:courseId",
      authenticateToken,
      async (req, res) => {
        try {
          const { courseId } = req.params;
          const userId = req.user.userId;

          await userCollection.updateOne(
            { _id: new ObjectId(userId) },
            { $pull: { wishlist: new ObjectId(courseId) } },
          );

          res.json({
            success: true,
            message: "Course removed from wishlist",
          });
        } catch (error) {
          logger.error("Remove wishlist error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to remove from wishlist",
            error:
              process.env.NODE_ENV === "development"
                ? error.message
                : undefined,
          });
        }
      },
    );

    // Get wishlist
    api.get("/users/wishlist", authenticateToken, async (req, res) => {
      try {
        const user = await userCollection.findOne(
          { _id: new ObjectId(req.user.userId) },
          { projection: { wishlist: 1 } },
        );

        const wishlistCourses = await courseCollection
          .find({ _id: { $in: user.wishlist || [] } })
          .toArray();

        res.json({
          success: true,
          wishlist: wishlistCourses,
        });
      } catch (error) {
        logger.error("Get wishlist error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch wishlist",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // Check if course is in wishlist
    api.get(
      "/users/wishlist/check/:courseId",
      authenticateToken,
      async (req, res) => {
        try {
          const { courseId } = req.params;
          const userId = req.user.userId;

          const user = await userCollection.findOne({
            _id: new ObjectId(userId),
            wishlist: new ObjectId(courseId),
          });

          res.json({
            success: true,
            isInWishlist: !!user,
          });
        } catch (error) {
          logger.error("Check wishlist error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to check wishlist",
            error:
              process.env.NODE_ENV === "development"
                ? error.message
                : undefined,
          });
        }
      },
    );

    // Get user notifications (OPTIMIZED)
    api.get("/users/notifications", authenticateToken, async (req, res) => {
      try {
        const userId = req.user.userId;

        // Only fetch the notifications field, not the entire user document
        const user = await userCollection.findOne(
          { _id: new ObjectId(userId) },
          { projection: { notifications: 1 } }, // Only get notifications
        );

        // Return notifications sorted by date (newest first)
        const notifications = (user?.notifications || []).sort(
          (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
        );

        res.json({
          success: true,
          notifications: notifications,
        });
      } catch (error) {
        logger.error("Get notifications error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch notifications",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // Mark notification as read
    api.put(
      "/users/notifications/:notificationId/read",
      authenticateToken,
      async (req, res) => {
        try {
          const { notificationId } = req.params;
          const userId = req.user.userId;

          await userCollection.updateOne(
            {
              _id: new ObjectId(userId),
              "notifications._id": new ObjectId(notificationId),
            },
            { $set: { "notifications.$.read": true } },
          );

          res.json({
            success: true,
            message: "Notification marked as read",
          });
        } catch (error) {
          logger.error("Mark notification error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to mark notification",
            error:
              process.env.NODE_ENV === "development"
                ? error.message
                : undefined,
          });
        }
      },
    );

    // Delete single notification
    api.delete(
      "/users/notifications/:notificationId",
      authenticateToken,
      async (req, res) => {
        try {
          const { notificationId } = req.params;
          const userId = req.user.userId;

          await userCollection.updateOne(
            { _id: new ObjectId(userId) },
            { $pull: { notifications: { _id: new ObjectId(notificationId) } } },
          );

          res.json({
            success: true,
            message: "Notification deleted successfully",
          });
        } catch (error) {
          logger.error("Delete notification error:", error);
          res
            .status(500)
            .json({ success: false, message: "Failed to delete notification" });
        }
      },
    );

    // Clear all notifications
    api.delete("/users/notifications", authenticateToken, async (req, res) => {
      try {
        const userId = req.user.userId;

        await userCollection.updateOne(
          { _id: new ObjectId(userId) },
          { $set: { notifications: [] } },
        );

        res.json({
          success: true,
          message: "All notifications cleared",
        });
      } catch (error) {
        logger.error("Clear notifications error:", error);
        res
          .status(500)
          .json({ success: false, message: "Failed to clear notifications" });
      }
    });

    // Update user settings
    api.put("/users/settings", authenticateToken, async (req, res) => {
      try {
        const { settings } = req.body;
        const userId = req.user.userId;

        await userCollection.updateOne(
          { _id: new ObjectId(userId) },
          { $set: { settings, updatedAt: new Date() } },
        );

        res.json({
          success: true,
          message: "Settings updated successfully",
        });
      } catch (error) {
        logger.error("Update settings error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to update settings",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // Change password (requires authentication)
    api.post("/change-password", authenticateToken, async (req, res) => {
      try {
        const { currentPassword, newPassword } = req.body;
        const userId = req.user.userId;

        // ===== PASSWORD STRENGTH VALIDATION =====
        if (newPassword.length < 6) {
          return res.status(400).json({
            success: false,
            message: "New password must be at least 6 characters long",
          });
        }

        // Get user
        const user = await userCollection.findOne({
          _id: new ObjectId(userId),
        });
        if (!user) {
          return res
            .status(404)
            .json({ success: false, message: "User not found" });
        }

        // Verify current password
        const isValidPassword = await bcrypt.compare(
          currentPassword,
          user.password,
        );
        if (!isValidPassword) {
          return res.status(401).json({
            success: false,
            message: "Current password is incorrect",
          });
        }

        // Hash new password
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        // Update password
        await userCollection.updateOne(
          { _id: new ObjectId(userId) },
          {
            $set: {
              password: hashedPassword,
              updatedAt: new Date(),
            },
          },
        );

        res.json({
          success: true,
          message: "Password changed successfully",
        });
      } catch (error) {
        logger.error("Change password error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to change password",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // ============= COURSE ROUTES =============

    api.get("/", (req, res) => {
      res.send(`LMS Training server is running on port ${PORT}`);
    });

    // GET all courses with admin access (shows ALL statuses)
    api.get("/courses", async (req, res) => {
      try {
        const {
          page = 1,
          limit = 10,
          category,
          level,
          status = "published",
          search,
          sortBy = "createdAt",
          sortOrder = -1,
          includeAll = false, // ✅ When true, shows ALL courses (admin only)
        } = req.query;

        const query = {};

        // ✅ If includeAll is true, show ALL courses (no status filter)
        // ✅ If includeAll is false, only show published courses
        if (!includeAll) {
          query.status = "published";
        }

        // Apply additional filters
        if (category) query.category = category;
        if (level) query.level = level;
        if (status && status !== "all") query.status = status;
        if (search) {
          query.$or = [
            { title: { $regex: search, $options: "i" } },
            { description: { $regex: search, $options: "i" } },
            { tags: { $in: [new RegExp(search, "i")] } },
          ];
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const courses = await courseCollection
          .find(query)
          .sort({ [sortBy]: parseInt(sortOrder) })
          .skip(skip)
          .limit(parseInt(limit))
          .toArray();

        const total = await courseCollection.countDocuments(query);

        res.json({
          success: true,
          courses,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            pages: Math.ceil(total / parseInt(limit)),
          },
        });
      } catch (error) {
        logger.error("Get courses error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch courses",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // READ single course by ID or slug
    api.get("/courses/:identifier", async (req, res) => {
      try {
        const { identifier } = req.params;

        let query;
        if (ObjectId.isValid(identifier)) {
          query = { _id: new ObjectId(identifier) };
        } else {
          query = { slug: identifier };
        }

        const course = await courseCollection.findOne(query);

        if (!course) {
          return res.status(404).json({
            success: false,
            message: "Course not found",
          });
        }

        // Get chapters for this course
        const chapters = await chapterCollection
          .find({ courseId: course._id })
          .sort({ order: 1 })
          .toArray();

        const chapterIds = chapters.map((ch) => ch._id);

        // Get lessons
        const lessons = await lessonCollection
          .find({ chapterId: { $in: chapterIds } })
          .sort({ order: 1 })
          .toArray();

        const lessonIds = lessons.map((l) => l._id);

        // Get topics count
        const topicsCount = await topicCollection.countDocuments({
          lessonId: { $in: lessonIds },
        });

        // Get enrolled students count
        const enrolledCount = await userCollection.countDocuments({
          "enrolledCourses.courseId": course._id,
        });

        const completeCourse = {
          ...course,
          stats: {
            ...course.stats,
            totalChapters: chapters.length,
            totalLessons: lessons.length,
            totalTopics: topicsCount,
            totalStudents: enrolledCount,
          },
          curriculum: chapters.map((chapter) => ({
            ...chapter,
            lessons: lessons.filter(
              (l) => l.chapterId.toString() === chapter._id.toString(),
            ),
          })),
        };

        res.json({
          success: true,
          course: completeCourse,
        });
      } catch (error) {
        logger.error("Get course error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch course",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // GET course by slug with all data
    api.get("/courses/:slug", async (req, res) => {
      try {
        const { slug } = req.params;

        const db = client.db("lmsDB");
        const courses = db.collection("courses");
        const chapters = db.collection("chapters");
        const lessons = db.collection("lessons");
        const topics = db.collection("topics");
        const users = db.collection("users");

        // Find course
        const course = await courses.findOne({ slug });

        if (!course) {
          return res.status(404).json({
            success: false,
            message: "Course not found",
          });
        }

        // Get chapters for this course
        const courseChapters = await chapters
          .find({ courseId: course._id })
          .sort({ order: 1 })
          .toArray();

        const chapterIds = courseChapters.map((ch) => ch._id);

        // Get lessons for these chapters
        const courseLessons = await lessons
          .find({ chapterId: { $in: chapterIds } })
          .sort({ order: 1 })
          .toArray();

        const lessonIds = courseLessons.map((l) => l._id);

        // Get topics count
        const topicsCount = await topics.countDocuments({
          lessonId: { $in: lessonIds },
        });

        // Get instructor details
        let instructorData = null;
        if (course.instructor?._id) {
          const instructor = await users.findOne(
            { _id: course.instructor._id },
            { projection: { password: 0, notifications: 0 } },
          );
          if (instructor) {
            instructorData = {
              ...instructor,
              ...course.instructor, // Override with course-specific instructor data
            };
          }
        }

        // Build complete course data
        const completeCourse = {
          ...course,
          stats: {
            ...course.stats,
            totalChapters: courseChapters.length,
            totalLessons: courseLessons.length,
            totalTopics: topicsCount,
            totalStudents: course.stats?.totalStudents || 0,
            averageRating: course.stats?.averageRating || 4.8,
            totalReviews: course.stats?.totalReviews || 0,
          },
          curriculum: courseChapters.map((chapter) => ({
            _id: chapter._id,
            title: chapter.title,
            description: chapter.description,
            order: chapter.order,
            lessonsCount: courseLessons.filter(
              (l) => l.chapterId.toString() === chapter._id.toString(),
            ).length,
            duration: chapter.duration || "45 mins",
            isFree: chapter.isFree || false,
            lessons: courseLessons
              .filter((l) => l.chapterId.toString() === chapter._id.toString())
              .map((lesson) => ({
                _id: lesson._id,
                title: lesson.title,
                duration: lesson.duration || "10 mins",
                type: lesson.type || "video",
              })),
          })),
          instructor: instructorData || course.instructor,
          settings: {
            hasCertificate: true,
            hasLifetimeAccess: true,
            hasMobileAccess: true,
            hasSubtitles: true,
            hasQuizzes: false,
            hasAssignments: false,
            hasProjects: true,
            hasCommunity: true,
            hasMentorship: false,
            moneyBackGuarantee: 30,
            ...course.settings,
          },
        };

        res.status(200).json({
          success: true,
          course: completeCourse,
        });
      } catch (error) {
        logger.error("Error fetching course:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch course",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // GET single course by ID
    api.get("/courses/id/:id", async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({
            success: false,
            message: "Invalid course ID format",
          });
        }

        const course = await courseCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!course) {
          return res.status(404).json({
            success: false,
            message: "Course not found",
          });
        }

        res.status(200).json({
          success: true,
          course,
        });
      } catch (error) {
        logger.error("Get course by ID error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch course",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // POST create new course
    // CREATE course (Admin/Instructor only)
    api.post("/courses", authenticateToken, async (req, res) => {
      try {
        const user = await userCollection.findOne({
          _id: new ObjectId(req.user.userId),
        });

        if (user.role !== "admin" && user.role !== "instructor") {
          return res.status(403).json({
            success: false,
            message:
              "Unauthorized: Only admins and instructors can create courses",
          });
        }

        const courseData = {
          ...req.body,
          _id: new ObjectId(),
          slug: generateSlug(req.body.title),
          instructor: {
            _id: user._id,
            name: user.name,
            avatar: user.profile?.photo || null,
            title: user.profile?.title || "Instructor",
          },
          stats: {
            totalChapters: 0,
            totalLessons: 0,
            totalTopics: 0,
            totalStudents: 0,
            averageRating: 0,
            totalReviews: 0,
            completionRate: 0,
            lastUpdated: new Date(),
            ...req.body.stats,
          },
          createdAt: new Date(),
          updatedAt: new Date(),
          status: req.body.status || "draft",
        };

        // Check if slug already exists
        const existingCourse = await courseCollection.findOne({
          slug: courseData.slug,
        });
        if (existingCourse) {
          courseData.slug = `${courseData.slug}-${Date.now()}`;
        }

        const result = await courseCollection.insertOne(courseData);

        res.status(201).json({
          success: true,
          message: "Course created successfully",
          course: { ...courseData, _id: result.insertedId },
        });
      } catch (error) {
        logger.error("Create course error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to create course",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // UPDATE course (Admin/Instructor only)
    api.patch("/courses/:id", authenticateToken, async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({
            success: false,
            message: "Invalid course ID",
          });
        }

        // Check permissions
        const user = await userCollection.findOne({
          _id: new ObjectId(req.user.userId),
        });
        const course = await courseCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!course) {
          return res.status(404).json({
            success: false,
            message: "Course not found",
          });
        }

        // Only admin or the instructor who created the course can update
        if (
          user.role !== "admin" &&
          course.instructor?._id?.toString() !== user._id.toString()
        ) {
          return res.status(403).json({
            success: false,
            message: "Unauthorized to update this course",
          });
        }

        const updateData = {
          ...req.body,
          updatedAt: new Date(),
        };

        // Update slug if title changed
        if (req.body.title && req.body.title !== course.title) {
          updateData.slug = generateSlug(req.body.title);

          // Check if new slug exists
          const existingCourse = await courseCollection.findOne({
            slug: updateData.slug,
            _id: { $ne: course._id },
          });

          if (existingCourse) {
            updateData.slug = `${updateData.slug}-${Date.now()}`;
          }
        }

        const result = await courseCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updateData },
        );

        res.json({
          success: true,
          message: "Course updated successfully",
          modifiedCount: result.modifiedCount,
        });
      } catch (error) {
        logger.error("Update course error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to update course",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });
    // GET featured reviews
    api.get("/courses/:courseId/reviews/featured", async (req, res) => {
      try {
        const { courseId } = req.params;

        const db = client.db("lmsDB");
        const reviews = db.collection("reviews");

        const featuredReviews = await reviews
          .find({
            courseId: new ObjectId(courseId),
            isFeatured: true,
          })
          .sort({ helpful: -1 })
          .limit(3)
          .toArray();

        res.json({
          success: true,
          reviews: featuredReviews,
        });
      } catch (error) {
        logger.error("Error fetching reviews:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch reviews",
        });
      }
    });

    // GET related courses
    api.get("/courses/:courseId/related", async (req, res) => {
      try {
        const { courseId } = req.params;

        const db = client.db("lmsDB");
        const courses = db.collection("courses");

        const currentCourse = await courses.findOne({
          _id: new ObjectId(courseId),
        });

        if (!currentCourse) {
          return res.status(404).json({ message: "Course not found" });
        }

        const relatedCourses = await courses
          .find({
            _id: { $ne: currentCourse._id },
            category: currentCourse.category,
            status: "published",
          })
          .limit(3)
          .project({
            title: 1,
            slug: 1,
            thumbnail: 1,
            level: 1,
            "price.regular": 1,
            "stats.averageRating": 1,
            "stats.totalStudents": 1,
          })
          .toArray();

        res.json({
          success: true,
          courses: relatedCourses,
        });
      } catch (error) {
        logger.error("Error fetching related courses:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch related courses",
        });
      }
    });
    // DELETE course
    // DELETE course (Admin only)
    api.delete("/courses/:id", authenticateToken, isAdmin, async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({
            success: false,
            message: "Invalid course ID",
          });
        }

        // Start a session for transaction
        const session = client.startSession();

        try {
          await session.withTransaction(async () => {
            // Delete course
            const courseResult = await courseCollection.deleteOne(
              { _id: new ObjectId(id) },
              { session },
            );

            if (courseResult.deletedCount === 0) {
              throw new Error("Course not found");
            }

            // Delete all chapters
            const chapters = await chapterCollection
              .find({ courseId: new ObjectId(id) })
              .toArray();

            const chapterIds = chapters.map((ch) => ch._id);

            if (chapterIds.length > 0) {
              // Delete all lessons
              const lessons = await lessonCollection
                .find({ chapterId: { $in: chapterIds } })
                .toArray();

              const lessonIds = lessons.map((l) => l._id);

              if (lessonIds.length > 0) {
                // Delete all topics
                await topicCollection.deleteMany(
                  { lessonId: { $in: lessonIds } },
                  { session },
                );
              }

              // Delete all lessons
              await lessonCollection.deleteMany(
                { chapterId: { $in: chapterIds } },
                { session },
              );

              // Delete all chapters
              await chapterCollection.deleteMany(
                { courseId: new ObjectId(id) },
                { session },
              );
            }

            // Remove course from users' enrolledCourses and wishlist
            await userCollection.updateMany(
              {},
              {
                $pull: {
                  enrolledCourses: { courseId: new ObjectId(id) },
                  wishlist: new ObjectId(id),
                },
              },
              { session },
            );

            // Delete all certificates for this course
            await certificateCollection.deleteMany(
              { courseId: new ObjectId(id) },
              { session },
            );

            // Delete all payments for this course
            await paymentCollection.deleteMany(
              { courseId: new ObjectId(id) },
              { session },
            );
          });

          await session.commitTransaction();

          res.json({
            success: true,
            message: "Course and all related content deleted successfully",
          });
        } finally {
          await session.endSession();
        }
      } catch (error) {
        logger.error("Delete course error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to delete course",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });
    // BULK operations on courses (Admin only)
    api.post("/courses/bulk", authenticateToken, isAdmin, async (req, res) => {
      try {
        const { action, courseIds, data } = req.body;

        if (!courseIds || !Array.isArray(courseIds) || courseIds.length === 0) {
          return res.status(400).json({
            success: false,
            message: "No courses selected",
          });
        }

        const objectIds = courseIds.map((id) => new ObjectId(id));
        let result;

        switch (action) {
          case "publish":
            result = await courseCollection.updateMany(
              { _id: { $in: objectIds } },
              {
                $set: {
                  status: "published",
                  publishedAt: new Date(),
                  updatedAt: new Date(),
                },
              },
            );
            break;

          case "draft":
            result = await courseCollection.updateMany(
              { _id: { $in: objectIds } },
              {
                $set: {
                  status: "draft",
                  updatedAt: new Date(),
                },
              },
            );
            break;

          case "archive":
            result = await courseCollection.updateMany(
              { _id: { $in: objectIds } },
              {
                $set: {
                  status: "archived",
                  updatedAt: new Date(),
                },
              },
            );
            break;

          case "feature":
            result = await courseCollection.updateMany(
              { _id: { $in: objectIds } },
              {
                $addToSet: {
                  badges: {
                    type: "featured",
                    text: "Featured",
                    icon: "⭐",
                    color: "amber",
                  },
                },
                $set: { updatedAt: new Date() },
              },
            );
            break;

          case "unfeature":
            result = await courseCollection.updateMany(
              { _id: { $in: objectIds } },
              {
                $pull: { badges: { type: "featured" } },
                $set: { updatedAt: new Date() },
              },
            );
            break;

          case "delete":
            result = { deletedCount: 0 };
            for (const id of objectIds) {
              // Delete each course with its related content
              await courseCollection.deleteOne({ _id: id });
              result.deletedCount++;
            }
            break;

          case "updateCategory":
            if (!data?.category) {
              return res.status(400).json({
                success: false,
                message: "Category is required",
              });
            }
            result = await courseCollection.updateMany(
              { _id: { $in: objectIds } },
              {
                $set: {
                  category: data.category,
                  updatedAt: new Date(),
                },
              },
            );
            break;

          default:
            return res.status(400).json({
              success: false,
              message: "Invalid action",
            });
        }

        res.json({
          success: true,
          message: `Bulk action '${action}' completed successfully`,
          modifiedCount: result.modifiedCount || result.deletedCount,
        });
      } catch (error) {
        logger.error("Bulk action error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to perform bulk action",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // ============= CHAPTER ROUTES =============
    // GET chapters by course ID (using course _id)
    api.get("/courses/:courseId/chapters", async (req, res) => {
      try {
        const { courseId } = req.params;
        logger.log("Fetching chapters for course identifier:", courseId);

        let course;
        const courseCollection = db.collection("courses");

        // Check if courseId is a valid ObjectId
        if (ObjectId.isValid(courseId)) {
          // Try to find by _id first
          course = await courseCollection.findOne({
            _id: new ObjectId(courseId),
          });
        }

        // If not found by _id or not a valid ObjectId, try by slug
        if (!course) {
          course = await courseCollection.findOne({ slug: courseId });
        }

        if (!course) {
          return res.status(404).json({
            success: false,
            message: "Course not found",
          });
        }

        logger.log("Found course:", course.title, "with _id:", course._id);

        // Find chapters using the course's _id
        const chapters = await db
          .collection("chapters")
          .find({ courseId: course._id })
          .sort({ order: 1 })
          .toArray();

        logger.log(`Found ${chapters.length} chapters`);
        res.json({ success: true, chapters });
      } catch (error) {
        logger.error("Get chapters error:", error);
        res.status(500).json({
          success: false,
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // GET single chapter by ID
    api.get("/chapters/:chapterId", async (req, res) => {
      try {
        const { chapterId } = req.params;

        let query;
        if (ObjectId.isValid(chapterId)) {
          query = { _id: new ObjectId(chapterId) };
        } else {
          query = { _id: chapterId };
        }

        const chapter = await db.collection("chapters").findOne(query);

        if (!chapter) {
          return res.status(404).json({
            success: false,
            message: "Chapter not found",
          });
        }

        res.json({
          success: true,
          chapter,
        });
      } catch (error) {
        logger.error("Get chapter error:", error);
        res.status(500).json({
          success: false,
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // POST create new chapter
    // CREATE chapter
    api.post("/chapters", authenticateToken, async (req, res) => {
      try {
        const { courseId, title, description, order } = req.body;

        // Check permissions
        const user = await userCollection.findOne({
          _id: new ObjectId(req.user.userId),
        });
        const course = await courseCollection.findOne({
          _id: new ObjectId(courseId),
        });

        if (!course) {
          return res.status(404).json({
            success: false,
            message: "Course not found",
          });
        }

        if (
          user.role !== "admin" &&
          course.instructor?._id?.toString() !== user._id.toString()
        ) {
          return res.status(403).json({
            success: false,
            message: "Unauthorized to add chapters to this course",
          });
        }

        const chapterData = {
          _id: new ObjectId(),
          courseId: new ObjectId(courseId),
          title,
          description: description || "",
          order: order || 0,
          lessonsCount: 0,
          duration: "0 mins",
          isFree: req.body.isFree || false,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const result = await chapterCollection.insertOne(chapterData);

        // Update course totalChapters
        await courseCollection.updateOne(
          { _id: new ObjectId(courseId) },
          { $inc: { "stats.totalChapters": 1 } },
        );

        res.status(201).json({
          success: true,
          message: "Chapter created successfully",
          chapter: { ...chapterData, _id: result.insertedId },
        });
      } catch (error) {
        logger.error("Create chapter error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to create chapter",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // PUT update chapter
    api.put("/chapters/:chapterId", async (req, res) => {
      try {
        const { chapterId } = req.params;
        const { title, description, order } = req.body;

        // Validate ID
        if (!ObjectId.isValid(chapterId)) {
          return res.status(400).json({
            success: false,
            message: "Invalid chapter ID format",
          });
        }

        const updateData = {
          ...(title && { title }),
          ...(description !== undefined && { description }),
          ...(order && { order: parseInt(order) }),
          updatedAt: new Date(),
        };

        const result = await db
          .collection("chapters")
          .updateOne({ _id: new ObjectId(chapterId) }, { $set: updateData });

        if (result.matchedCount === 0) {
          return res.status(404).json({
            success: false,
            message: "Chapter not found",
          });
        }

        res.json({
          success: true,
          message: "Chapter updated successfully",
        });
      } catch (error) {
        logger.error("Update chapter error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to update chapter",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // DELETE chapter
    api.delete("/chapters/:id", authenticateToken, async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({
            success: false,
            message: "Invalid chapter ID",
          });
        }

        const chapter = await chapterCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!chapter) {
          return res.status(404).json({
            success: false,
            message: "Chapter not found",
          });
        }

        // Check permissions
        const user = await userCollection.findOne({
          _id: new ObjectId(req.user.userId),
        });
        const course = await courseCollection.findOne({
          _id: chapter.courseId,
        });

        if (
          user.role !== "admin" &&
          course?.instructor?._id?.toString() !== user._id.toString()
        ) {
          return res.status(403).json({
            success: false,
            message: "Unauthorized to delete this chapter",
          });
        }

        // Delete all lessons and topics in this chapter
        const lessons = await lessonCollection
          .find({ chapterId: chapter._id })
          .toArray();

        const lessonIds = lessons.map((l) => l._id);

        if (lessonIds.length > 0) {
          await topicCollection.deleteMany({ lessonId: { $in: lessonIds } });
          await lessonCollection.deleteMany({ chapterId: chapter._id });
        }

        await chapterCollection.deleteOne({ _id: chapter._id });

        // Update course stats
        await courseCollection.updateOne(
          { _id: chapter.courseId },
          {
            $inc: {
              "stats.totalChapters": -1,
              "stats.totalLessons": -lessons.length,
            },
          },
        );

        res.json({
          success: true,
          message: "Chapter and all its content deleted successfully",
        });
      } catch (error) {
        logger.error("Delete chapter error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to delete chapter",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // POST reorder chapters
    api.post("/chapters/reorder", async (req, res) => {
      try {
        const { chapters } = req.body;

        if (!Array.isArray(chapters)) {
          return res.status(400).json({
            success: false,
            message: "Chapters must be an array",
          });
        }

        // Update each chapter's order
        for (const item of chapters) {
          await db
            .collection("chapters")
            .updateOne(
              { _id: new ObjectId(item._id) },
              { $set: { order: item.order, updatedAt: new Date() } },
            );
        }

        res.json({
          success: true,
          message: "Chapters reordered successfully",
        });
      } catch (error) {
        logger.error("Reorder chapters error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to reorder chapters",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // ============= LESSON ROUTES =============
    // GET lessons by chapter ID
    api.get("/chapters/:chapterId/lessons", async (req, res) => {
      try {
        const { chapterId } = req.params;
        logger.log("Fetching lessons for chapter:", chapterId);

        let query;
        if (ObjectId.isValid(chapterId)) {
          query = { chapterId: new ObjectId(chapterId) };
        } else {
          // If it's not a valid ObjectId, it might be a slug or string
          // First find the chapter by slug or other identifier
          const chapter = await db.collection("chapters").findOne({
            $or: [
              { slug: chapterId },
              {
                _id: ObjectId.isValid(chapterId)
                  ? new ObjectId(chapterId)
                  : null,
              },
            ].filter(Boolean),
          });

          if (chapter) {
            query = { chapterId: chapter._id };
          } else {
            query = { chapterId: chapterId };
          }
        }

        const lessons = await db
          .collection("lessons")
          .find(query)
          .sort({ order: 1 })
          .toArray();

        logger.log(`Found ${lessons.length} lessons`);
        res.json({ success: true, lessons });
      } catch (error) {
        logger.error("Get lessons error:", error);
        res.status(500).json({
          success: false,
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // GET all lessons (with optional filtering)
    api.get("/lessons", async (req, res) => {
      try {
        const { chapterId } = req.query;
        let query = {};

        // If chapterId is provided, filter by it
        if (chapterId) {
          if (ObjectId.isValid(chapterId)) {
            query = { chapterId: new ObjectId(chapterId) };
          } else {
            // Try to find chapter by slug
            const chapter = await db
              .collection("chapters")
              .findOne({ slug: chapterId });
            if (chapter) {
              query = { chapterId: chapter._id };
            }
          }
        }

        const lessons = await db
          .collection("lessons")
          .find(query)
          .sort({ order: 1 })
          .toArray();

        logger.log(`Found ${lessons.length} lessons`);
        res.json({ success: true, lessons });
      } catch (error) {
        logger.error("Get all lessons error:", error);
        res.status(500).json({
          success: false,
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // GET single lesson with its topics
    api.get("/lessons/:lessonId", async (req, res) => {
      try {
        const { lessonId } = req.params;
        logger.log("Fetching lesson with topics:", lessonId);

        let lessonQuery;
        if (ObjectId.isValid(lessonId)) {
          lessonQuery = { _id: new ObjectId(lessonId) };
        } else {
          lessonQuery = { _id: lessonId };
        }

        const lesson = await db.collection("lessons").findOne(lessonQuery);

        if (!lesson) {
          return res
            .status(404)
            .json({ success: false, message: "Lesson not found" });
        }

        let topicQuery;
        if (ObjectId.isValid(lessonId)) {
          topicQuery = { lessonId: new ObjectId(lessonId) };
        } else {
          topicQuery = { lessonId: lessonId };
        }

        const topics = await db
          .collection("topics")
          .find(topicQuery)
          .sort({ order: 1 })
          .toArray();

        logger.log(`Found ${topics.length} topics for lesson`);
        res.json({ success: true, lesson, topics });
      } catch (error) {
        logger.error("Get lesson error:", error);
        res.status(500).json({
          success: false,
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // CREATE lesson
    api.post("/lessons", authenticateToken, async (req, res) => {
      try {
        const { chapterId, title, description, type, duration, order } =
          req.body;

        const chapter = await chapterCollection.findOne({
          _id: new ObjectId(chapterId),
        });

        if (!chapter) {
          return res.status(404).json({
            success: false,
            message: "Chapter not found",
          });
        }

        // Check permissions
        const user = await userCollection.findOne({
          _id: new ObjectId(req.user.userId),
        });
        const course = await courseCollection.findOne({
          _id: chapter.courseId,
        });

        if (
          user.role !== "admin" &&
          course?.instructor?._id?.toString() !== user._id.toString()
        ) {
          return res.status(403).json({
            success: false,
            message: "Unauthorized to add lessons to this course",
          });
        }

        const lessonData = {
          _id: new ObjectId(),
          chapterId: new ObjectId(chapterId),
          courseId: chapter.courseId,
          title,
          description: description || "",
          type: type || "video",
          duration: duration || "0 mins",
          order: order || 0,
          topicsCount: 0,
          isFree: req.body.isFree || false,
          content: req.body.content || {},
          resources: req.body.resources || [],
          attachments: req.body.attachments || [],
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const result = await lessonCollection.insertOne(lessonData);

        // Update chapter and course counts
        await chapterCollection.updateOne(
          { _id: chapter._id },
          { $inc: { lessonsCount: 1 } },
        );

        await courseCollection.updateOne(
          { _id: chapter.courseId },
          { $inc: { "stats.totalLessons": 1 } },
        );

        res.status(201).json({
          success: true,
          message: "Lesson created successfully",
          lesson: { ...lessonData, _id: result.insertedId },
        });
      } catch (error) {
        logger.error("Create lesson error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to create lesson",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // PUT update lesson
    api.put("/lessons/:lessonId", async (req, res) => {
      try {
        const { lessonId } = req.params;
        const { title, description, order } = req.body;

        // Validate ID
        if (!ObjectId.isValid(lessonId)) {
          return res.status(400).json({
            success: false,
            message: "Invalid lesson ID format",
          });
        }

        // Get current lesson to find chapterId for later
        const currentLesson = await db.collection("lessons").findOne({
          _id: new ObjectId(lessonId),
        });

        if (!currentLesson) {
          return res.status(404).json({
            success: false,
            message: "Lesson not found",
          });
        }

        const updateData = {
          ...(title && { title }),
          ...(description !== undefined && { description }),
          ...(order && { order: parseInt(order) }),
          updatedAt: new Date(),
        };

        const result = await db
          .collection("lessons")
          .updateOne({ _id: new ObjectId(lessonId) }, { $set: updateData });

        res.json({
          success: true,
          message: "Lesson updated successfully",
        });
      } catch (error) {
        logger.error("Update lesson error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to update lesson",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // DELETE lesson
    api.delete("/lessons/:id", authenticateToken, async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({
            success: false,
            message: "Invalid lesson ID",
          });
        }

        const lesson = await lessonCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!lesson) {
          return res.status(404).json({
            success: false,
            message: "Lesson not found",
          });
        }

        // Check permissions
        const user = await userCollection.findOne({
          _id: new ObjectId(req.user.userId),
        });
        const course = await courseCollection.findOne({ _id: lesson.courseId });

        if (
          user.role !== "admin" &&
          course?.instructor?._id?.toString() !== user._id.toString()
        ) {
          return res.status(403).json({
            success: false,
            message: "Unauthorized to delete this lesson",
          });
        }

        // Delete all topics in this lesson
        const topicsCount = await topicCollection.countDocuments({
          lessonId: lesson._id,
        });
        await topicCollection.deleteMany({ lessonId: lesson._id });

        await lessonCollection.deleteOne({ _id: lesson._id });

        // Update chapter and course counts
        await chapterCollection.updateOne(
          { _id: lesson.chapterId },
          { $inc: { lessonsCount: -1 } },
        );

        await courseCollection.updateOne(
          { _id: lesson.courseId },
          {
            $inc: {
              "stats.totalLessons": -1,
              "stats.totalTopics": -topicsCount,
            },
          },
        );

        res.json({
          success: true,
          message: "Lesson and all its topics deleted successfully",
        });
      } catch (error) {
        logger.error("Delete lesson error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to delete lesson",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // POST reorder lessons
    api.post("/lessons/reorder", async (req, res) => {
      try {
        const { lessons } = req.body;

        if (!Array.isArray(lessons)) {
          return res.status(400).json({
            success: false,
            message: "Lessons must be an array",
          });
        }

        // Update each lesson's order
        for (const item of lessons) {
          await db
            .collection("lessons")
            .updateOne(
              { _id: new ObjectId(item._id) },
              { $set: { order: item.order, updatedAt: new Date() } },
            );
        }

        res.json({
          success: true,
          message: "Lessons reordered successfully",
        });
      } catch (error) {
        logger.error("Reorder lessons error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to reorder lessons",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // ============= TOPIC ROUTES =============
    // GET all topics for a lesson
    api.get("/lessons/:lessonId/topics", async (req, res) => {
      try {
        const { lessonId } = req.params;
        logger.log("Fetching topics for lesson:", lessonId);

        let query;
        if (ObjectId.isValid(lessonId)) {
          query = { lessonId: new ObjectId(lessonId) };
        } else {
          query = { lessonId: lessonId };
        }

        const topics = await db
          .collection("topics")
          .find(query)
          .sort({ order: 1 })
          .toArray();

        logger.log(`Found ${topics.length} topics`);
        res.json({ success: true, topics });
      } catch (error) {
        logger.error("Get topics error:", error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // ==================== TOPIC APIs ====================

    // CREATE topic with blocks (including code blocks with highlighting)
    api.post(
      "/lessons/:lessonId/topics",
      authenticateToken,
      async (req, res) => {
        try {
          const { lessonId } = req.params;
          const { title, description, blocks, order } = req.body;

          // Validate lesson exists
          if (!ObjectId.isValid(lessonId)) {
            return res.status(400).json({
              success: false,
              message: "Invalid lesson ID format",
            });
          }

          const lesson = await lessonCollection.findOne({
            _id: new ObjectId(lessonId),
          });

          if (!lesson) {
            return res.status(404).json({
              success: false,
              message: "Lesson not found",
            });
          }

          // Check permissions
          const user = await userCollection.findOne({
            _id: new ObjectId(req.user.userId),
          });
          const course = await courseCollection.findOne({
            _id: lesson.courseId,
          });

          if (
            user.role !== "admin" &&
            course?.instructor?._id?.toString() !== user._id.toString()
          ) {
            return res.status(403).json({
              success: false,
              message: "Unauthorized to add topics to this lesson",
            });
          }

          const newTopic = {
            _id: new ObjectId(),
            lessonId: new ObjectId(lessonId),
            courseId: lesson.courseId,
            chapterId: lesson.chapterId,
            title,
            description: description || "",
            order: order || 0,
            blocks: blocks.map((block, index) => ({
              id: new ObjectId(),
              order: index,
              type: block.type,
              content: block.content,
              ...(block.type === "code" && {
                language: block.language || "javascript",
                highlightedLines: block.highlightedLines || [],
                showLineNumbers: block.showLineNumbers !== false,
                variant: block.variant || "default",
              }),
              ...(block.type === "text" && {
                style: block.style || "normal",
              }),
              ...(block.type === "note" && {
                variant: block.variant || "info",
              }),
              ...(block.type === "component" && {
                component: block.component,
                props: block.props || {},
              }),
              ...(block.type === "quiz" && {
                question: block.question,
                options: block.options || [],
                correctAnswer: block.correctAnswer,
              }),
              ...(block.type === "list" && {
                items: block.items || [],
                listType: block.listType || "unordered",
              }),
              ...(block.type === "resource" && {
                resources: block.resources || [],
                resourceType: block.resourceType,
              }),
              metadata: {
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            })),
            createdAt: new Date(),
            updatedAt: new Date(),
          };

          const result = await topicCollection.insertOne(newTopic);

          // Update lesson topics count
          await lessonCollection.updateOne(
            { _id: new ObjectId(lessonId) },
            { $inc: { topicsCount: 1 } },
          );

          // Update course stats
          await courseCollection.updateOne(
            { _id: lesson.courseId },
            { $inc: { "stats.totalTopics": 1 } },
          );

          res.status(201).json({
            success: true,
            message: "Topic created successfully",
            topic: { ...newTopic, _id: result.insertedId },
          });
        } catch (error) {
          logger.error("Create topic error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to create topic",
            error:
              process.env.NODE_ENV === "development"
                ? error.message
                : undefined,
          });
        }
      },
    );

    // GET single topic by ID
    api.get("/lessons/:lessonId/topics/:topicId", async (req, res) => {
      try {
        const { lessonId, topicId } = req.params;

        if (!ObjectId.isValid(topicId)) {
          return res.status(400).json({
            success: false,
            message: "Invalid topic ID format",
          });
        }

        const topic = await topicCollection.findOne({
          _id: new ObjectId(topicId),
          lessonId: new ObjectId(lessonId),
        });

        if (!topic) {
          return res.status(404).json({
            success: false,
            message: "Topic not found",
          });
        }

        res.json({ success: true, topic });
      } catch (error) {
        logger.error("Get topic error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to get topic",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // UPDATE topic
    api.put(
      "/lessons/:lessonId/topics/:topicId",
      authenticateToken,
      async (req, res) => {
        try {
          const { lessonId, topicId } = req.params;
          const { title, description, blocks, order } = req.body;

          if (!ObjectId.isValid(topicId)) {
            return res.status(400).json({
              success: false,
              message: "Invalid topic ID format",
            });
          }

          // Check permissions
          const lesson = await lessonCollection.findOne({
            _id: new ObjectId(lessonId),
          });
          const user = await userCollection.findOne({
            _id: new ObjectId(req.user.userId),
          });
          const course = await courseCollection.findOne({
            _id: lesson.courseId,
          });

          if (
            user.role !== "admin" &&
            course?.instructor?._id?.toString() !== user._id.toString()
          ) {
            return res.status(403).json({
              success: false,
              message: "Unauthorized to update this topic",
            });
          }

          const updateData = {
            ...(title && { title }),
            ...(description !== undefined && { description }),
            ...(order !== undefined && { order }),
            ...(blocks && {
              blocks: blocks.map((block, index) => ({
                ...block,
                order: index,
                metadata: {
                  ...block.metadata,
                  updatedAt: new Date(),
                },
              })),
            }),
            updatedAt: new Date(),
          };

          const result = await topicCollection.updateOne(
            { _id: new ObjectId(topicId), lessonId: new ObjectId(lessonId) },
            { $set: updateData },
          );

          if (result.matchedCount === 0) {
            return res.status(404).json({
              success: false,
              message: "Topic not found",
            });
          }

          res.json({
            success: true,
            message: "Topic updated successfully",
          });
        } catch (error) {
          logger.error("Update topic error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to update topic",
            error:
              process.env.NODE_ENV === "development"
                ? error.message
                : undefined,
          });
        }
      },
    );

    // DELETE topic
    api.delete(
      "/lessons/:lessonId/topics/:topicId",
      authenticateToken,
      async (req, res) => {
        try {
          const { lessonId, topicId } = req.params;

          if (!ObjectId.isValid(topicId)) {
            return res.status(400).json({
              success: false,
              message: "Invalid topic ID format",
            });
          }

          // Check permissions
          const lesson = await lessonCollection.findOne({
            _id: new ObjectId(lessonId),
          });
          const user = await userCollection.findOne({
            _id: new ObjectId(req.user.userId),
          });
          const course = await courseCollection.findOne({
            _id: lesson.courseId,
          });

          if (
            user.role !== "admin" &&
            course?.instructor?._id?.toString() !== user._id.toString()
          ) {
            return res.status(403).json({
              success: false,
              message: "Unauthorized to delete this topic",
            });
          }

          const result = await topicCollection.deleteOne({
            _id: new ObjectId(topicId),
            lessonId: new ObjectId(lessonId),
          });

          if (result.deletedCount === 0) {
            return res.status(404).json({
              success: false,
              message: "Topic not found",
            });
          }

          // Update lesson topics count
          await lessonCollection.updateOne(
            { _id: new ObjectId(lessonId) },
            { $inc: { topicsCount: -1 } },
          );

          // Update course stats
          await courseCollection.updateOne(
            { _id: lesson.courseId },
            { $inc: { "stats.totalTopics": -1 } },
          );

          res.json({
            success: true,
            message: "Topic deleted successfully",
          });
        } catch (error) {
          logger.error("Delete topic error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to delete topic",
            error:
              process.env.NODE_ENV === "development"
                ? error.message
                : undefined,
          });
        }
      },
    );

    // ==================== BLOCK APIs (with Code Block Highlighting) ====================

    // ADD block to topic
    api.post(
      "/lessons/:lessonId/topics/:topicId/blocks",
      authenticateToken,
      async (req, res) => {
        try {
          const { lessonId, topicId } = req.params;
          const { type, content, ...blockSpecificData } = req.body;

          if (!ObjectId.isValid(topicId)) {
            return res.status(400).json({
              success: false,
              message: "Invalid topic ID format",
            });
          }

          // Check permissions
          const lesson = await lessonCollection.findOne({
            _id: new ObjectId(lessonId),
          });
          const user = await userCollection.findOne({
            _id: new ObjectId(req.user.userId),
          });
          const course = await courseCollection.findOne({
            _id: lesson.courseId,
          });

          if (
            user.role !== "admin" &&
            course?.instructor?._id?.toString() !== user._id.toString()
          ) {
            return res.status(403).json({
              success: false,
              message: "Unauthorized to add blocks to this topic",
            });
          }

          const newBlock = {
            id: new ObjectId(),
            type,
            content,
            ...(type === "code" && {
              language: blockSpecificData.language || "javascript",
              highlightedLines: blockSpecificData.highlightedLines || [],
              showLineNumbers: blockSpecificData.showLineNumbers !== false,
              variant: blockSpecificData.variant || "default",
            }),
            ...(type === "text" && {
              style: blockSpecificData.style || "normal",
            }),
            ...(type === "note" && {
              variant: blockSpecificData.variant || "info",
            }),
            ...(type === "component" && {
              component: blockSpecificData.component,
              props: blockSpecificData.props || {},
            }),
            metadata: {
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          };

          const result = await topicCollection.updateOne(
            { _id: new ObjectId(topicId), lessonId: new ObjectId(lessonId) },
            { $push: { blocks: newBlock } },
          );

          if (result.matchedCount === 0) {
            return res.status(404).json({
              success: false,
              message: "Topic not found",
            });
          }

          res.status(201).json({
            success: true,
            message: "Block added successfully",
            block: newBlock,
          });
        } catch (error) {
          logger.error("Add block error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to add block",
            error:
              process.env.NODE_ENV === "development"
                ? error.message
                : undefined,
          });
        }
      },
    );

    // GET all blocks for a topic
    api.get("/lessons/:lessonId/topics/:topicId/blocks", async (req, res) => {
      try {
        const { lessonId, topicId } = req.params;

        if (!ObjectId.isValid(topicId)) {
          return res.status(400).json({
            success: false,
            message: "Invalid topic ID format",
          });
        }

        const topic = await topicCollection.findOne(
          {
            _id: new ObjectId(topicId),
            lessonId: new ObjectId(lessonId),
          },
          { projection: { blocks: 1 } },
        );

        if (!topic) {
          return res.status(404).json({
            success: false,
            message: "Topic not found",
          });
        }

        res.json({
          success: true,
          blocks: topic.blocks || [],
        });
      } catch (error) {
        logger.error("Get blocks error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to get blocks",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // GET single block
    api.get(
      "/lessons/:lessonId/topics/:topicId/blocks/:blockId",
      async (req, res) => {
        try {
          const { lessonId, topicId, blockId } = req.params;

          if (!ObjectId.isValid(topicId) || !ObjectId.isValid(blockId)) {
            return res.status(400).json({
              success: false,
              message: "Invalid ID format",
            });
          }

          const topic = await topicCollection.findOne(
            {
              _id: new ObjectId(topicId),
              lessonId: new ObjectId(lessonId),
              "blocks.id": new ObjectId(blockId),
            },
            { projection: { "blocks.$": 1 } },
          );

          if (!topic || !topic.blocks || topic.blocks.length === 0) {
            return res.status(404).json({
              success: false,
              message: "Block not found",
            });
          }

          res.json({
            success: true,
            block: topic.blocks[0],
          });
        } catch (error) {
          logger.error("Get block error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to get block",
            error:
              process.env.NODE_ENV === "development"
                ? error.message
                : undefined,
          });
        }
      },
    );

    // UPDATE block (with support for code block highlighting)
    api.put(
      "/lessons/:lessonId/topics/:topicId/blocks/:blockId",
      authenticateToken,
      async (req, res) => {
        try {
          const { lessonId, topicId, blockId } = req.params;
          const updateData = req.body;

          if (!ObjectId.isValid(topicId) || !ObjectId.isValid(blockId)) {
            return res.status(400).json({
              success: false,
              message: "Invalid ID format",
            });
          }

          // Check permissions
          const lesson = await lessonCollection.findOne({
            _id: new ObjectId(lessonId),
          });
          const user = await userCollection.findOne({
            _id: new ObjectId(req.user.userId),
          });
          const course = await courseCollection.findOne({
            _id: lesson.courseId,
          });

          if (
            user.role !== "admin" &&
            course?.instructor?._id?.toString() !== user._id.toString()
          ) {
            return res.status(403).json({
              success: false,
              message: "Unauthorized to update this block",
            });
          }

          // Build dynamic update object for array filter
          const updateFields = {};

          if (updateData.content !== undefined) {
            updateFields["blocks.$[block].content"] = updateData.content;
          }

          if (updateData.language !== undefined) {
            updateFields["blocks.$[block].language"] = updateData.language;
          }

          if (updateData.highlightedLines !== undefined) {
            updateFields["blocks.$[block].highlightedLines"] =
              updateData.highlightedLines;
          }

          if (updateData.showLineNumbers !== undefined) {
            updateFields["blocks.$[block].showLineNumbers"] =
              updateData.showLineNumbers;
          }

          if (updateData.variant !== undefined) {
            updateFields["blocks.$[block].variant"] = updateData.variant;
          }

          if (updateData.style !== undefined) {
            updateFields["blocks.$[block].style"] = updateData.style;
          }

          if (updateData.component !== undefined) {
            updateFields["blocks.$[block].component"] = updateData.component;
          }

          if (updateData.props !== undefined) {
            updateFields["blocks.$[block].props"] = updateData.props;
          }

          // Always update metadata
          updateFields["blocks.$[block].metadata.updatedAt"] = new Date();

          const result = await topicCollection.updateOne(
            {
              _id: new ObjectId(topicId),
              lessonId: new ObjectId(lessonId),
            },
            { $set: updateFields },
            {
              arrayFilters: [{ "block.id": new ObjectId(blockId) }],
            },
          );

          if (result.matchedCount === 0) {
            return res.status(404).json({
              success: false,
              message: "Block not found",
            });
          }

          res.json({
            success: true,
            message: "Block updated successfully",
          });
        } catch (error) {
          logger.error("Update block error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to update block",
            error:
              process.env.NODE_ENV === "development"
                ? error.message
                : undefined,
          });
        }
      },
    );

    // DELETE block
    api.delete(
      "/lessons/:lessonId/topics/:topicId/blocks/:blockId",
      authenticateToken,
      async (req, res) => {
        try {
          const { lessonId, topicId, blockId } = req.params;

          if (!ObjectId.isValid(topicId) || !ObjectId.isValid(blockId)) {
            return res.status(400).json({
              success: false,
              message: "Invalid ID format",
            });
          }

          // Check permissions
          const lesson = await lessonCollection.findOne({
            _id: new ObjectId(lessonId),
          });
          const user = await userCollection.findOne({
            _id: new ObjectId(req.user.userId),
          });
          const course = await courseCollection.findOne({
            _id: lesson.courseId,
          });

          if (
            user.role !== "admin" &&
            course?.instructor?._id?.toString() !== user._id.toString()
          ) {
            return res.status(403).json({
              success: false,
              message: "Unauthorized to delete this block",
            });
          }

          const result = await topicCollection.updateOne(
            {
              _id: new ObjectId(topicId),
              lessonId: new ObjectId(lessonId),
            },
            {
              $pull: {
                blocks: { id: new ObjectId(blockId) },
              },
            },
          );

          if (result.matchedCount === 0) {
            return res.status(404).json({
              success: false,
              message: "Topic not found",
            });
          }

          res.json({
            success: true,
            message: "Block deleted successfully",
          });
        } catch (error) {
          logger.error("Delete block error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to delete block",
            error:
              process.env.NODE_ENV === "development"
                ? error.message
                : undefined,
          });
        }
      },
    );

    // ==================== CODE BLOCK SPECIFIC APIs ====================

    // UPDATE highlighted lines for code block
    api.patch(
      "/lessons/:lessonId/topics/:topicId/blocks/:blockId/highlights",
      authenticateToken,
      async (req, res) => {
        try {
          const { lessonId, topicId, blockId } = req.params;
          const { highlightedLines, action } = req.body; // action: 'set', 'add', 'remove'

          if (!ObjectId.isValid(topicId) || !ObjectId.isValid(blockId)) {
            return res.status(400).json({
              success: false,
              message: "Invalid ID format",
            });
          }

          // Check permissions
          const lesson = await lessonCollection.findOne({
            _id: new ObjectId(lessonId),
          });
          const user = await userCollection.findOne({
            _id: new ObjectId(req.user.userId),
          });
          const course = await courseCollection.findOne({
            _id: lesson.courseId,
          });

          if (
            user.role !== "admin" &&
            course?.instructor?._id?.toString() !== user._id.toString()
          ) {
            return res.status(403).json({
              success: false,
              message: "Unauthorized to update highlights",
            });
          }

          let updateOperation;

          switch (action) {
            case "add":
              updateOperation = {
                $addToSet: {
                  "blocks.$[block].highlightedLines": {
                    $each: highlightedLines,
                  },
                },
              };
              break;
            case "remove":
              updateOperation = {
                $pull: {
                  "blocks.$[block].highlightedLines": { $in: highlightedLines },
                },
              };
              break;
            default:
              // 'set' - replace entire array
              updateOperation = {
                $set: {
                  "blocks.$[block].highlightedLines": highlightedLines,
                },
              };
          }

          // Add metadata update
          updateOperation.$set = updateOperation.$set || {};
          updateOperation.$set["blocks.$[block].metadata.updatedAt"] =
            new Date();

          const result = await topicCollection.updateOne(
            {
              _id: new ObjectId(topicId),
              lessonId: new ObjectId(lessonId),
            },
            updateOperation,
            {
              arrayFilters: [{ "block.id": new ObjectId(blockId) }],
            },
          );

          if (result.matchedCount === 0) {
            return res.status(404).json({
              success: false,
              message: "Code block not found",
            });
          }

          res.json({
            success: true,
            message: "Highlights updated successfully",
            modified: result.modifiedCount,
          });
        } catch (error) {
          logger.error("Update highlights error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to update highlights",
            error:
              process.env.NODE_ENV === "development"
                ? error.message
                : undefined,
          });
        }
      },
    );

    // GET highlighted lines for code block
    api.get(
      "/lessons/:lessonId/topics/:topicId/blocks/:blockId/highlights",
      async (req, res) => {
        try {
          const { lessonId, topicId, blockId } = req.params;

          if (!ObjectId.isValid(topicId) || !ObjectId.isValid(blockId)) {
            return res.status(400).json({
              success: false,
              message: "Invalid ID format",
            });
          }

          const topic = await topicCollection.findOne(
            {
              _id: new ObjectId(topicId),
              lessonId: new ObjectId(lessonId),
              "blocks.id": new ObjectId(blockId),
            },
            {
              projection: {
                blocks: {
                  $elemMatch: { id: new ObjectId(blockId) },
                },
              },
            },
          );

          if (!topic || !topic.blocks || topic.blocks.length === 0) {
            return res.status(404).json({
              success: false,
              message: "Code block not found",
            });
          }

          const block = topic.blocks[0];

          res.json({
            success: true,
            highlightedLines: block.highlightedLines || [],
            language: block.language,
            code: block.content,
            showLineNumbers: block.showLineNumbers !== false,
          });
        } catch (error) {
          logger.error("Get highlights error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to get highlights",
            error:
              process.env.NODE_ENV === "development"
                ? error.message
                : undefined,
          });
        }
      },
    );

    // ==================== SEARCH APIs ====================

    // Search across lessons and topics (with code block content)
    api.get("/search", async (req, res) => {
      try {
        const { q, type, limit = 20 } = req.query;

        if (!q) {
          return res.status(400).json({
            success: false,
            message: "Search query required",
          });
        }

        const searchRegex = new RegExp(q, "i");
        let results = {
          lessons: [],
          topics: [],
          codeBlocks: [],
        };

        // Search in lessons
        const lessons = await lessonCollection
          .find({
            $or: [{ title: searchRegex }, { description: searchRegex }],
          })
          .limit(parseInt(limit))
          .toArray();

        results.lessons = lessons;

        // Search in topics
        const topics = await topicCollection
          .find({
            $or: [
              { title: searchRegex },
              { description: searchRegex },
              { "blocks.content": searchRegex },
              { "blocks.highlightedLines": { $exists: true } }, // Include topics with highlighted code
            ],
          })
          .limit(parseInt(limit))
          .toArray();

        results.topics = topics;

        // Search specifically in code blocks
        const codeBlocks = await topicCollection
          .aggregate([
            { $unwind: "$blocks" },
            {
              $match: {
                "blocks.type": "code",
                $or: [
                  { "blocks.content": searchRegex },
                  { "blocks.language": searchRegex },
                ],
              },
            },
            {
              $project: {
                topicTitle: "$title",
                blockContent: "$blocks.content",
                language: "$blocks.language",
                highlightedLines: "$blocks.highlightedLines",
                lessonId: 1,
              },
            },
            { $limit: parseInt(limit) },
          ])
          .toArray();

        results.codeBlocks = codeBlocks;

        res.json({
          success: true,
          results,
          total: lessons.length + topics.length + codeBlocks.length,
        });
      } catch (error) {
        logger.error("Search error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to search",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // ==================== ANALYTICS APIs ====================

    // Get code block analytics
    api.get("/analytics/code-blocks", async (req, res) => {
      try {
        const stats = await topicCollection
          .aggregate([
            { $unwind: "$blocks" },
            { $match: { "blocks.type": "code" } },
            {
              $group: {
                _id: null,
                totalCodeBlocks: { $sum: 1 },
                totalHighlightedLines: {
                  $sum: {
                    $size: { $ifNull: ["$blocks.highlightedLines", []] },
                  },
                },
                languages: { $addToSet: "$blocks.language" },
                averageHighlightsPerBlock: {
                  $avg: {
                    $size: { $ifNull: ["$blocks.highlightedLines", []] },
                  },
                },
                blocksWithHighlights: {
                  $sum: {
                    $cond: [
                      {
                        $gt: [
                          {
                            $size: {
                              $ifNull: ["$blocks.highlightedLines", []],
                            },
                          },
                          0,
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
              },
            },
          ])
          .toArray();

        // Get top highlighted code blocks
        const topHighlighted = await topicCollection
          .aggregate([
            { $unwind: "$blocks" },
            {
              $match: {
                "blocks.type": "code",
                $expr: { $gt: [{ $size: "$blocks.highlightedLines" }, 0] },
              },
            },
            {
              $project: {
                topicTitle: "$title",
                language: "$blocks.language",
                highlightCount: { $size: "$blocks.highlightedLines" },
                highlightedLines: "$blocks.highlightedLines",
              },
            },
            { $sort: { highlightCount: -1 } },
            { $limit: 10 },
          ])
          .toArray();

        res.json({
          success: true,
          stats: stats[0] || {
            totalCodeBlocks: 0,
            totalHighlightedLines: 0,
            languages: [],
            averageHighlightsPerBlock: 0,
            blocksWithHighlights: 0,
          },
          topHighlighted,
        });
      } catch (error) {
        logger.error("Analytics error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to get analytics",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // Get lesson-specific code block analytics
    api.get("/lessons/:lessonId/analytics/code-blocks", async (req, res) => {
      try {
        const { lessonId } = req.params;

        if (!ObjectId.isValid(lessonId)) {
          return res.status(400).json({
            success: false,
            message: "Invalid lesson ID format",
          });
        }

        const stats = await topicCollection
          .aggregate([
            { $match: { lessonId: new ObjectId(lessonId) } },
            { $unwind: "$blocks" },
            { $match: { "blocks.type": "code" } },
            {
              $group: {
                _id: "$lessonId",
                totalCodeBlocks: { $sum: 1 },
                totalHighlightedLines: {
                  $sum: {
                    $size: { $ifNull: ["$blocks.highlightedLines", []] },
                  },
                },
                topicsWithCode: { $addToSet: "$_id" },
              },
            },
          ])
          .toArray();

        res.json({
          success: true,
          stats: stats[0] || {
            totalCodeBlocks: 0,
            totalHighlightedLines: 0,
            topicsWithCode: [],
          },
        });
      } catch (error) {
        logger.error("Lesson analytics error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to get lesson analytics",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // GET single topic by ID
    api.get("/topics/:topicId", async (req, res) => {
      try {
        const { topicId } = req.params;

        if (!ObjectId.isValid(topicId)) {
          return res
            .status(400)
            .json({ success: false, message: "Invalid topic ID format" });
        }

        const topic = await db.collection("topics").findOne({
          _id: new ObjectId(topicId),
        });

        if (!topic) {
          return res
            .status(404)
            .json({ success: false, message: "Topic not found" });
        }

        res.json({ success: true, topic });
      } catch (error) {
        logger.error("Get topic error:", error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // CREATE topic
    api.post("/topics", authenticateToken, async (req, res) => {
      try {
        const { lessonId, title, content, type, duration, order } = req.body;

        const lesson = await lessonCollection.findOne({
          _id: new ObjectId(lessonId),
        });

        if (!lesson) {
          return res.status(404).json({
            success: false,
            message: "Lesson not found",
          });
        }

        // Check permissions
        const user = await userCollection.findOne({
          _id: new ObjectId(req.user.userId),
        });
        const course = await courseCollection.findOne({ _id: lesson.courseId });

        if (
          user.role !== "admin" &&
          course?.instructor?._id?.toString() !== user._id.toString()
        ) {
          return res.status(403).json({
            success: false,
            message: "Unauthorized to add topics to this course",
          });
        }

        const topicData = {
          _id: new ObjectId(),
          lessonId: new ObjectId(lessonId),
          chapterId: lesson.chapterId,
          courseId: lesson.courseId,
          title,
          content: content || {},
          type: type || "reading",
          duration: duration || "5 mins",
          order: order || 0,
          codeSnippets: req.body.codeSnippets || [],
          images: req.body.images || [],
          downloads: req.body.downloads || [],
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const result = await topicCollection.insertOne(topicData);

        // Update lesson and course counts
        await lessonCollection.updateOne(
          { _id: lesson._id },
          { $inc: { topicsCount: 1 } },
        );

        await courseCollection.updateOne(
          { _id: lesson.courseId },
          { $inc: { "stats.totalTopics": 1 } },
        );

        res.status(201).json({
          success: true,
          message: "Topic created successfully",
          topic: { ...topicData, _id: result.insertedId },
        });
      } catch (error) {
        logger.error("Create topic error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to create topic",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    api.put("/topics/:topicId", async (req, res) => {
      try {
        const { topicId } = req.params;
        const { title, content, order } = req.body;

        // Validate ID
        if (!ObjectId.isValid(topicId)) {
          return res
            .status(400)
            .json({ success: false, message: "Invalid topic ID format" });
        }

        const updateData = {
          ...(title && { title }),
          ...(content && { content }),
          ...(order && { order: parseInt(order) }),
          updatedAt: new Date(),
        };

        const result = await db
          .collection("topics")
          .updateOne({ _id: new ObjectId(topicId) }, { $set: updateData });

        if (result.matchedCount === 0) {
          return res
            .status(404)
            .json({ success: false, message: "Topic not found" });
        }

        res.json({
          success: true,
          message: "Topic updated successfully",
        });
      } catch (error) {
        logger.error("Update topic error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to update topic",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // DELETE topic
    api.delete("/topics/:id", authenticateToken, async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({
            success: false,
            message: "Invalid topic ID",
          });
        }

        const topic = await topicCollection.findOne({ _id: new ObjectId(id) });

        if (!topic) {
          return res.status(404).json({
            success: false,
            message: "Topic not found",
          });
        }

        // Check permissions
        const user = await userCollection.findOne({
          _id: new ObjectId(req.user.userId),
        });
        const course = await courseCollection.findOne({ _id: topic.courseId });

        if (
          user.role !== "admin" &&
          course?.instructor?._id?.toString() !== user._id.toString()
        ) {
          return res.status(403).json({
            success: false,
            message: "Unauthorized to delete this topic",
          });
        }

        await topicCollection.deleteOne({ _id: topic._id });

        // Update lesson and course counts
        await lessonCollection.updateOne(
          { _id: topic.lessonId },
          { $inc: { topicsCount: -1 } },
        );

        await courseCollection.updateOne(
          { _id: topic.courseId },
          { $inc: { "stats.totalTopics": -1 } },
        );

        res.json({
          success: true,
          message: "Topic deleted successfully",
        });
      } catch (error) {
        logger.error("Delete topic error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to delete topic",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    api.post("/topics/reorder", async (req, res) => {
      try {
        const { topics } = req.body;

        if (!Array.isArray(topics)) {
          return res.status(400).json({
            success: false,
            message: "Topics must be an array",
          });
        }

        // Update each topic's order
        for (const item of topics) {
          await db
            .collection("topics")
            .updateOne(
              { _id: new ObjectId(item._id) },
              { $set: { order: item.order, updatedAt: new Date() } },
            );
        }

        res.json({
          success: true,
          message: "Topics reordered successfully",
        });
      } catch (error) {
        logger.error("Reorder topics error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to reorder topics",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // ============= INSTRUCTOR ANNOUNCEMENT ROUTE =============
    // Send announcement to all enrolled students
    api.post(
      "/courses/:courseId/announcement",
      authenticateToken,
      async (req, res) => {
        try {
          const { courseId } = req.params;
          const { title, message } = req.body;
          const userId = req.user.userId;

          // Check if user is instructor or admin
          const user = await userCollection.findOne({
            _id: new ObjectId(userId),
          });
          if (user.role !== "instructor" && user.role !== "admin") {
            return res.status(403).json({
              success: false,
              message:
                "Unauthorized: Only instructors and admins can send announcements",
            });
          }

          // Get course details
          const course = await courseCollection.findOne({
            _id: new ObjectId(courseId),
          });

          if (!course) {
            return res.status(404).json({
              success: false,
              message: "Course not found",
            });
          }

          // Validate input
          if (!title || !message) {
            return res.status(400).json({
              success: false,
              message: "Title and message are required",
            });
          }

          // Send announcement to all enrolled students
          await notificationService.sendToCourseStudents(courseId, {
            type: "announcement",
            message: `📢 ${title}`,
            details: message,
            actionUrl: `/course/${course.slug || courseId}/announcements`,
          });

          res.json({
            success: true,
            message: "Announcement sent successfully to all enrolled students",
          });
        } catch (error) {
          logger.error("Send announcement error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to send announcement",
            error:
              process.env.NODE_ENV === "development"
                ? error.message
                : undefined,
          });
        }
      },
    );

    // GET enrolled students count
    api.get("/courses/:courseId/enrolled-count", async (req, res) => {
      try {
        const { courseId } = req.params;

        const db = client.db("lmsDB");
        const users = db.collection("users");

        const count = await users.countDocuments({
          "enrolledCourses.courseId": new ObjectId(courseId),
        });

        res.json({
          success: true,
          count,
        });
      } catch (error) {
        logger.error("Error fetching enrolled count:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch enrolled count",
        });
      }
    });

    // 1. Create bKash payment (initialize payment)
    api.post("/payments/bkash/create", authenticateToken, async (req, res) => {
      try {
        const { courseId, amount } = req.body;
        const userId = req.user.userId;

        // Validate course exists
        const course = await courseCollection.findOne({
          _id: new ObjectId(courseId),
        });
        if (!course) {
          return res
            .status(404)
            .json({ success: false, message: "Course not found" });
        }

        // Check if already enrolled
        const user = await userCollection.findOne({
          _id: new ObjectId(userId),
          "enrolledCourses.courseId": new ObjectId(courseId),
        });

        if (user) {
          return res.status(400).json({
            success: false,
            message: "Already enrolled in this course",
          });
        }

        // Generate unique invoice number
        const merchantInvoiceNumber = generateInvoiceNumber();

        // Create payment record in database
        const paymentData = {
          userId: new ObjectId(userId),
          courseId: new ObjectId(courseId),
          amount: parseFloat(amount),
          currency: "BDT",
          merchantInvoiceNumber,
          status: "INITIATED",
          paymentMethod: "bkash",
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        await paymentCollection.insertOne(paymentData);

        // Get bKash token
        const tokenResponse = await axios.post(
          `${BKASH_CONFIG.base_url}/tokenized/checkout/token/grant`,
          {
            app_key: BKASH_CONFIG.app_key,
            app_secret: BKASH_CONFIG.app_secret,
          },
          {
            headers: {
              "Content-Type": "application/json",
              username: BKASH_CONFIG.username,
              password: BKASH_CONFIG.password,
            },
          },
        );

        if (!tokenResponse.data || !tokenResponse.data.id_token) {
          throw new Error("Failed to get bKash token");
        }

        const id_token = tokenResponse.data.id_token;

        // Create bKash payment
        const paymentResponse = await axios.post(
          `${BKASH_CONFIG.base_url}/tokenized/checkout/create`,
          {
            mode: "0011",
            payerReference: userId.toString(),
            callbackURL: `${process.env.BACKEND_URL || "http://localhost:7000"}/payments/bkash/callback`,
            amount: amount.toString(),
            currency: "BDT",
            intent: "sale",
            merchantInvoiceNumber: merchantInvoiceNumber,
          },
          {
            headers: {
              "Content-Type": "application/json",
              Authorization: id_token,
              "X-APP-Key": BKASH_CONFIG.app_key,
            },
          },
        );

        if (paymentResponse.data && paymentResponse.data.bkashURL) {
          // Update payment record with bKash paymentID
          await paymentCollection.updateOne(
            { merchantInvoiceNumber },
            {
              $set: {
                bkashPaymentID: paymentResponse.data.paymentID,
                updatedAt: new Date(),
              },
            },
          );

          res.json({
            success: true,
            bkashURL: paymentResponse.data.bkashURL,
            paymentID: paymentResponse.data.paymentID,
            merchantInvoiceNumber,
          });
        } else {
          throw new Error("Failed to create bKash payment");
        }
      } catch (error) {
        logger.error("bKash create payment error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to create payment",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // 2. bKash Callback URL (handles payment response)
    api.get("/payments/bkash/callback", async (req, res) => {
      try {
        const { paymentID, status } = req.query;

        logger.log("📞 bKash Callback received:", { paymentID, status });

        if (status === "success" && paymentID) {
          // First, find the payment by paymentID to get merchantInvoiceNumber
          const payment = await paymentCollection.findOne({
            bkashPaymentID: paymentID,
          });

          if (!payment) {
            logger.error("❌ Payment not found for paymentID:", paymentID);
            return res.redirect(
              `${process.env.BKASH_FRONTEND_URL}/payment/failed?error=payment_not_found`,
            );
          }

          logger.log("✅ Found payment record:", {
            merchantInvoiceNumber: payment.merchantInvoiceNumber,
            amount: payment.amount,
          });

          // Execute payment
          const executeResponse = await executeBkashPayment(paymentID);

          if (executeResponse.success && executeResponse.data) {
            // Make sure we have the trxID
            const bKashData = executeResponse.data;

            if (!bKashData.trxID) {
              logger.error("❌ No trxID in bKash response:", bKashData);
              return res.redirect(
                `${process.env.BKASH_FRONTEND_URL}/payment/failed?error=no_transaction_id`,
              );
            }

            logger.log(
              "✅ Payment executed successfully with trxID:",
              bKashData.trxID,
            );

            // Update payment status and enroll user
            await handleSuccessfulPayment(
              bKashData,
              payment.merchantInvoiceNumber,
            );

            // Redirect to frontend success page with invoice
            return res.redirect(
              `${process.env.BKASH_FRONTEND_URL}/payment/success?invoice=${payment.merchantInvoiceNumber}`,
            );
          } else {
            logger.error("❌ Payment execution failed:", executeResponse.error);
            return res.redirect(
              `${process.env.BKASH_FRONTEND_URL}/payment/failed?invoice=${payment.merchantInvoiceNumber}`,
            );
          }
        } else {
          // Payment failed or cancelled
          logger.log("❌ Payment failed or cancelled:", { paymentID, status });

          if (paymentID) {
            const payment = await paymentCollection.findOne({
              bkashPaymentID: paymentID,
            });
            if (payment) {
              await paymentCollection.updateOne(
                { _id: payment._id },
                {
                  $set: {
                    status: "FAILED",
                    updatedAt: new Date(),
                  },
                },
              );
              return res.redirect(
                `${process.env.BKASH_FRONTEND_URL}/payment/failed?invoice=${payment.merchantInvoiceNumber}`,
              );
            }
          }

          return res.redirect(
            `${process.env.BKASH_FRONTEND_URL}/payment/failed`,
          );
        }
      } catch (error) {
        logger.error("❌ bKash callback error:", error);
        res.redirect(`${process.env.BKASH_FRONTEND_URL}/payment/error`);
      }
    });

    // Helper function to execute bKash payment
    async function executeBkashPayment(paymentID) {
      try {
        logger.log("🔄 Executing bKash payment for paymentID:", paymentID);

        // Get new token for execution
        const tokenResponse = await axios.post(
          `${BKASH_CONFIG.base_url}/tokenized/checkout/token/grant`,
          {
            app_key: BKASH_CONFIG.app_key,
            app_secret: BKASH_CONFIG.app_secret,
          },
          {
            headers: {
              "Content-Type": "application/json",
              username: BKASH_CONFIG.username,
              password: BKASH_CONFIG.password,
            },
          },
        );

        const id_token = tokenResponse.data.id_token;
        logger.log("✅ Got execution token");

        // Execute payment
        const executeResponse = await axios.post(
          `${BKASH_CONFIG.base_url}/tokenized/checkout/execute`,
          { paymentID },
          {
            headers: {
              "Content-Type": "application/json",
              Authorization: id_token,
              "X-APP-Key": BKASH_CONFIG.app_key,
            },
          },
        );

        logger.log("✅ bKash execute response received:", {
          trxID: executeResponse.data.trxID,
          amount: executeResponse.data.amount,
          paymentID: executeResponse.data.paymentID,
        });

        return { success: true, data: executeResponse.data };
      } catch (error) {
        logger.error(
          "❌ Execute bKash payment error:",
          error.response?.data || error.message,
        );
        return { success: false, error: error.message };
      }
    }

    // 3. Query payment status
    api.get(
      "/payments/status/:merchantInvoiceNumber",
      authenticateToken,
      async (req, res) => {
        try {
          const { merchantInvoiceNumber } = req.params;
          const userId = req.user.userId;

          const payment = await paymentCollection.findOne({
            merchantInvoiceNumber,
            userId: new ObjectId(userId),
          });

          if (!payment) {
            return res
              .status(404)
              .json({ success: false, message: "Payment not found" });
          }

          // Get course details
          const course = await courseCollection.findOne(
            { _id: payment.courseId },
            { projection: { title: 1, duration: 1, thumbnail: 1 } },
          );

          // Get user details
          const user = await userCollection.findOne(
            { _id: userId },
            { projection: { name: 1, email: 1 } },
          );

          res.json({
            success: true,
            payment: {
              ...payment,
              courseTitle: course?.title,
              courseDuration: course?.duration,
              studentName: user?.name,
              studentEmail: user?.email,
            },
          });
        } catch (error) {
          logger.error("Payment status error:", error);
          res
            .status(500)
            .json({ success: false, message: "Failed to get payment status" });
        }
      },
    );

    // 4. Get payment history for user
    api.get("/payments/history", authenticateToken, async (req, res) => {
      try {
        const userId = req.user.userId;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        const payments = await paymentCollection
          .find({ userId: new ObjectId(userId) })
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .toArray();

        const total = await paymentCollection.countDocuments({
          userId: new ObjectId(userId),
        });

        // Get course details for each payment
        const paymentsWithCourses = await Promise.all(
          payments.map(async (payment) => {
            const course = await courseCollection.findOne(
              { _id: payment.courseId },
              { projection: { title: 1, thumbnail: 1 } },
            );
            return {
              ...payment,
              course,
            };
          }),
        );

        res.json({
          success: true,
          payments: paymentsWithCourses,
          pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit),
          },
        });
      } catch (error) {
        logger.error("Payment history error:", error);
        res
          .status(500)
          .json({ success: false, message: "Failed to get payment history" });
      }
    });

    // ============= EMAIL TEMPLATES =============
    const emailTemplates = {
      // Payment Confirmation Email
      paymentConfirmation: (data) => ({
        subject: `🎉 Payment Confirmed - Enrollment Successful for ${data.courseTitle}`,
        html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Payment Confirmation</title>
        <style>
          body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            line-height: 1.6;
            color: #333333;
            margin: 0;
            padding: 0;
            background-color: #f5f5f5;
          }
          .container {
            max-width: 600px;
            margin: 20px auto;
            background: white;
            border-radius: 16px;
            overflow: hidden;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
          }
          .header {
            background: linear-gradient(135deg, #0D9488 0%, #0F766E 100%);
            padding: 40px 30px;
            text-align: center;
          }
          .header h1 {
            margin: 0;
            color: white;
            font-size: 28px;
            font-weight: 600;
          }
          .header p {
            margin: 10px 0 0;
            color:black;
            font-size: 16px;
          }
          .content {
            padding: 40px 30px;
          }
          .success-badge {
            background: #10B981;
            color: white;
            padding: 8px 20px;
            border-radius: 50px;
            display: inline-block;
            font-weight: 600;
            margin-bottom: 30px;
          }
          .details-card {
            background: #F3F4F6;
            border-radius: 12px;
            padding: 25px;
            margin: 25px 0;
          }
          .details-row {
            display: flex;
            justify-content: space-between;
            padding: 12px 0;
            border-bottom: 1px solid #E5E7EB;
          }
          .details-row:last-child {
            border-bottom: none;
          }
          .details-label {
            font-weight: 600;
            color: #4B5563;
          }
          .details-value {
            font-weight: 500;
            color: #0D9488;
          }
          .amount {
            font-size: 24px;
            font-weight: 700;
            color: #0D9488;
          }
          .button {
            display: inline-block;
            background: #0D9488;
            color: white;
            text-decoration: none;
            padding: 14px 30px;
            border-radius: 8px;
            font-weight: 600;
            margin: 20px 0;
            text-align: center;
          }
          .button:hover {
            background: #0F766E;
          }
          .footer {
            background: #F9FAFB;
            padding: 30px;
            text-align: center;
            border-top: 1px solid #E5E7EB;
          }
          .footer p {
            margin: 5px 0;
            color: #6B7280;
            font-size: 14px;
          }
          .social-links {
            margin: 20px 0;
          }
          .social-links a {
            display: inline-block;
            margin: 0 10px;
            color: #6B7280;
            text-decoration: none;
          }
          .invoice-table {
            width: 100%;
            border-collapse: collapse;
            margin: 20px 0;
          }
          .invoice-table th {
            background: #E5E7EB;
            padding: 12px;
            text-align: left;
            font-weight: 600;
          }
          .invoice-table td {
            padding: 12px;
            border-bottom: 1px solid #E5E7EB;
          }
          .invoice-table tr:last-child td {
            border-bottom: none;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🎉 Payment Confirmed!</h1>
            <p>Your enrollment was successful</p>
          </div>
          
          <div class="content">
            <div style="text-align: center;">
              <span class="success-badge">✓ Payment Successful</span>
            </div>
            
            <p style="font-size: 18px; text-align: center;">Hello <strong>${data.studentName}</strong>,</p>
            <p style="text-align: center;">Thank you for your payment! You are now successfully enrolled in:</p>
            
            <h2 style="text-align: center; color: #0D9488; margin: 20px 0;">${data.courseTitle}</h2>
            
            <div class="details-card">
              <h3 style="margin-top: 0; color: #1F2937;">📋 Payment Receipt</h3>
              
              <div class="details-row">
                <span class="details-label">Transaction ID:</span>
                <span class="details-value">${data.trxID}</span>
              </div>
              
              <div class="details-row">
                <span class="details-label">Invoice Number:</span>
                <span class="details-value">${data.merchantInvoiceNumber}</span>
              </div>
              
              <div class="details-row">
                <span class="details-label">Payment Date:</span>
                <span class="details-value">${new Date(data.paymentDate).toLocaleString("en-BD", { timeZone: "Asia/Dhaka" })}</span>
              </div>
              
              <div class="details-row">
                <span class="details-label">Payment Method:</span>
                <span class="details-value">bKash</span>
              </div>
              
              <div class="details-row">
                <span class="details-label">Amount Paid:</span>
                <span class="details-value amount">৳${data.amount.toLocaleString()}</span>
              </div>
            </div>
            
            <table class="invoice-table">
              <tr>
                <th>Description</th>
                <th>Duration</th>
                <th>Amount</th>
              </tr>
              <tr>
                <td>${data.courseTitle}</td>
                <td>${data.courseDuration}</td>
                <td>৳${data.amount.toLocaleString()}</td>
              </tr>
              <tr>
                <td colspan="2" style="text-align: right; font-weight: 600;">Total:</td>
                <td style="font-weight: 700; color: #0D9488;">৳${data.amount.toLocaleString()}</td>
              </tr>
            </table>
            
            <div style="background: #EFF6FF; border-radius: 8px; padding: 20px; margin: 25px 0;">
              <h4 style="margin-top: 0; color: #1E40AF;">📚 Course Access Details:</h4>
              <ul style="list-style-type: none; padding: 0;">
                <li style="margin: 10px 0;">✓ <strong>Access Duration:</strong> ${data.courseDuration}</li>
                <li style="margin: 10px 0;">✓ <strong>Course Level:</strong> ${data.courseLevel}</li>
                <li style="margin: 10px 0;">✓ <strong>Total Chapters:</strong> ${data.totalChapters}</li>
                <li style="margin: 10px 0;">✓ <strong>Total Lessons:</strong> ${data.totalLessons}</li>
                <li style="margin: 10px 0;">✓ <strong>Certificate:</strong> Available upon completion</li>
              </ul>
            </div>
            
            <div style="text-align: center;">
              <a href="${data.courseUrl}" class="button">🎯 Start Learning Now</a>
            </div>
            
            <div style="margin: 30px 0; padding: 20px; background: #F3F4F6; border-radius: 8px;">
              <h4 style="margin-top: 0;">📱 Need Help?</h4>
              <p>If you have any questions about your purchase or need technical support:</p>
              <p>📧 Email: teams.rcsbd@gmail.com<br>
              📞 Phone: +880 1715697780<br>
            </div>
          </div>
          
          <div class="footer">
            <div class="social-links">
              <a href="#">Facebook</a> • 
              <a href="#">Twitter</a> • 
              <a href="#">LinkedIn</a> • 
              <a href="#">Instagram</a>
            </div>
            <p>© ${new Date().getFullYear()} Reliable Code Solutions. All rights reserved.</p>
            <p>1212 East Shewrapara, Mirpur, Dhaka 1216, Bangladesh</p>
            <p style="font-size: 12px;">This is a system generated email. Please do not reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `,
      }),

      // Invoice PDF Template (for attachment - optional)
      invoiceTemplate: (data) => `
    Reliable Code Solutions - OFFICIAL RECEIPT
    ==============================
    
    Receipt No: ${data.merchantInvoiceNumber}
    Date: ${new Date(data.paymentDate).toLocaleDateString("en-BD")}
    
    STUDENT DETAILS
    ---------------
    Name: ${data.studentName}
    Email: ${data.studentEmail}
    Student ID: ${data.studentId}
    
    PAYMENT DETAILS
    ---------------
    Transaction ID: ${data.trxID}
    Payment Method: bKash
    Amount: ৳${data.amount}
    
    COURSE DETAILS
    --------------
    Course: ${data.courseTitle}
    Duration: ${data.courseDuration}
    Level: ${data.courseLevel}
    Instructor: ${data.instructorName || "Course Team"}
    
    PAYMENT SUMMARY
    ---------------
    Subtotal: ৳${data.amount}
    VAT (0%): ৳0
    Total: ৳${data.amount}
    
    Status: PAID ✓
    
    ==============================
    This is a computer generated receipt.
    For any queries, contact support@lmsacademy.com
    ==============================
  `,
    };

    // ============= PAYMENT EMAIL SERVICE =============
    const paymentEmailService = {
      // Send payment confirmation email
      sendPaymentConfirmation: async (paymentData, userData, courseData) => {
        try {
          logger.log(
            "📧 Preparing payment confirmation email for:",
            userData.email,
          );

          // Prepare email data
          const emailData = {
            studentName: userData.name,
            studentEmail: userData.email,
            studentId: userData.uniqueId,
            courseTitle: courseData.title,
            courseDuration: courseData.duration,
            courseLevel: courseData.level,
            courseUrl: `${process.env.BKASH_FRONTEND_URL}/course/${courseData.slug || courseData._id}`,
            totalChapters: courseData.totalChapters || 0,
            totalLessons: courseData.totalLessons || 0,
            amount: paymentData.amount,
            trxID: paymentData.trxID,
            merchantInvoiceNumber: paymentData.merchantInvoiceNumber,
            paymentDate: paymentData.updatedAt || new Date(),
            instructorName: courseData.instructorName || "Mohammad Alauddin",
          };

          // Get email template
          const template = emailTemplates.paymentConfirmation(emailData);

          // Create PDF invoice (optional - you'd need a PDF library like pdfkit)
          // const pdfBuffer = await generatePDFInvoice(emailData);

          // Send email
          const mailOptions = {
            from: {
              name: "Reliable Code Solutions",
              address: process.env.EMAIL_USER,
            },
            to: userData.email,
            subject: template.subject,
            html: template.html,
          };

          // const info = await transporter.sendMail(mailOptions);
          const info = transporter.sendMail(mailOptions);
          logger.log("✅ Payment confirmation email sent:", info.messageId);

          // Log email in database
          await db.collection("emailLogs").insertOne({
            type: "payment_confirmation",
            userId: userData._id,
            email: userData.email,
            merchantInvoiceNumber: paymentData.merchantInvoiceNumber,
            messageId: info.messageId,
            sentAt: new Date(),
            status: "sent",
          });

          return { success: true, messageId: info.messageId };
        } catch (error) {
          logger.error("❌ Failed to send payment confirmation email:", error);

          // Log failed email
          await db.collection("emailLogs").insertOne({
            type: "payment_confirmation",
            userId: userData?._id,
            email: userData?.email,
            merchantInvoiceNumber: paymentData?.merchantInvoiceNumber,
            error:
              process.env.NODE_ENV === "development"
                ? error.message
                : undefined,
            attemptedAt: new Date(),
            status: "failed",
          });

          return { success: false, error: error.message };
        }
      },

      // Send payment receipt to admin (optional)
      sendAdminNotification: async (paymentData, userData, courseData) => {
        try {
          const adminEmail = process.env.ADMIN_EMAIL || "teams.rcsbd@gmail.com";

          const mailOptions = {
            from: process.env.EMAIL_USER,
            to: adminEmail,
            subject: `💰 New Payment Received: ৳${paymentData.amount} - ${courseData.title}`,
            html: `
          <h2>New Payment Received</h2>
          <p><strong>Student:</strong> ${userData.name} (${userData.email})</p>
          <p><strong>Course:</strong> ${courseData.title}</p>
          <p><strong>Amount:</strong> ৳${paymentData.amount}</p>
          <p><strong>Transaction ID:</strong> ${paymentData.trxID}</p>
          <p><strong>Invoice:</strong> ${paymentData.merchantInvoiceNumber}</p>
          <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
        `,
          };

          await transporter.sendMail(mailOptions);
          logger.log("✅ Admin notification sent");
        } catch (error) {
          logger.error("❌ Failed to send admin notification:", error);
        }
      },
    };

    // ============= UPDATE THE HANDLE SUCCESSFUL PAYMENT FUNCTION =============
    // Update the handleSuccessfulPayment function with stats updates
    async function handleSuccessfulPayment(bKashData, merchantInvoiceNumber) {
      try {
        logger.log("💰 Handling successful payment:", {
          trxID: bKashData.trxID,
          merchantInvoiceNumber,
        });

        // Update payment record with bKash data
        const updateResult = await paymentCollection.updateOne(
          { merchantInvoiceNumber },
          {
            $set: {
              status: "COMPLETED",
              trxID: bKashData.trxID,
              paymentID: bKashData.paymentID,
              amount: parseFloat(bKashData.amount) || undefined,
              paymentData: {
                ...bKashData,
                receivedAt: new Date(),
              },
              updatedAt: new Date(),
            },
          },
        );

        logger.log("✅ Payment record updated:", updateResult);

        // Find the updated payment to get userId and courseId
        const payment = await paymentCollection.findOne({
          merchantInvoiceNumber,
        });

        if (!payment) {
          logger.error(
            "❌ Payment not found after update:",
            merchantInvoiceNumber,
          );
          return;
        }

        logger.log("✅ Found payment record:", {
          userId: payment.userId,
          courseId: payment.courseId,
          amount: payment.amount,
        });

        // Get course details
        const course = await courseCollection.findOne({
          _id: payment.courseId,
        });
        if (!course) {
          logger.error("❌ Course not found:", payment.courseId);
          return;
        }

        // Get user details
        const user = await userCollection.findOne({ _id: payment.userId });
        if (!user) {
          logger.error("❌ User not found:", payment.userId);
          return;
        }

        logger.log("✅ Found course and user:", {
          course: course.title,
          user: user.email,
        });

        // Calculate end date based on course duration
        const daysToAdd = parseDurationToDays(course.duration);
        const endDate = new Date(Date.now() + daysToAdd * 24 * 60 * 60 * 1000);

        // Enroll user in course
        const enrollmentData = {
          courseId: payment.courseId,
          enrollmentDate: new Date(),
          startDate: new Date(),
          endDate: endDate,
          status: "active",
          progress: {
            overall: 0,
            completedChapters: [],
            completedLessons: [],
            completedTopics: [],
            lastAccessed: new Date(),
            timeSpent: 0,
          },
          certificate: {
            issued: false,
            issueDate: null,
            certificateUrl: null,
            certificateId: null,
          },
        };

        const enrollResult = await userCollection.updateOne(
          { _id: payment.userId },
          { $push: { enrolledCourses: enrollmentData } },
        );

        logger.log("✅ User enrolled successfully:", enrollResult);

        // ===== UPDATE COURSE STATS =====
        // Increment total students count
        await courseCollection.updateOne(
          { _id: payment.courseId },
          { $inc: { "stats.totalStudents": 1 } },
        );

        // Also update the enrolled students count in course stats if needed
        await courseCollection.updateOne(
          { _id: payment.courseId },
          { $inc: { "stats.enrolledCount": 1 } },
        );

        logger.log("✅ Course stats updated: totalStudents incremented");

        // ===== UPDATE INSTRUCTOR STATS =====
        // Update instructor's students taught count if instructor exists
        if (course.instructor?._id) {
          await userCollection.updateOne(
            { _id: course.instructor._id },
            { $inc: { studentsTaught: 1 } },
          );
          logger.log("✅ Instructor stats updated: studentsTaught incremented");
        }

        // ===== UPDATE REVENUE STATS =====
        // Update revenue analytics collection
        await revenueAnalyticsCollection.insertOne({
          courseId: payment.courseId,
          userId: payment.userId,
          amount: parseFloat(bKashData.amount) || payment.amount,
          transactionId: bKashData.trxID,
          date: new Date(),
          month: new Date().getMonth() + 1,
          year: new Date().getFullYear(),
        });

        // Send in-app notification
        await notificationService.sendToUser(payment.userId, {
          type: "course",
          message: `Payment successful! You're now enrolled in '${course.title}'`,
          details: `Transaction ID: ${bKashData.trxID}`,
          actionUrl: `/course/${course.slug || payment.courseId}`,
        });

        // Send payment confirmation email
        try {
          await paymentEmailService.sendPaymentConfirmation(
            {
              ...payment,
              trxID: bKashData.trxID,
              amount: parseFloat(bKashData.amount) || payment.amount,
            },
            user,
            course,
          );
          logger.log("✅ Payment confirmation email sent");
        } catch (emailError) {
          logger.error("❌ Failed to send email:", emailError);
        }

        // Optional: Send admin notification
        try {
          await paymentEmailService.sendAdminNotification(
            { ...payment, trxID: bKashData.trxID },
            user,
            course,
          );
        } catch (adminError) {
          logger.error("❌ Failed to send admin notification:", adminError);
        }
      } catch (error) {
        logger.error("❌ Handle successful payment error:", error);
      }
    }

    // Helper function to format date
    const formatDate = (date) => {
      return new Date(date).toLocaleDateString("en-BD", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    };

    // Generate PDF Receipt
    const generatePDFReceipt = async (payment, user, course) => {
      return new Promise((resolve, reject) => {
        try {
          // Create a PDF document
          const doc = new PDFDocument({
            size: "A4",
            margin: 50,
            info: {
              Title: `Payment Receipt - ${payment.merchantInvoiceNumber}`,
              Author: "Reliable Code Solutions",
              Subject: "Course Payment Receipt",
              Keywords: "receipt, payment, lms",
              Creator: "Reliable Code Solutions",
            },
          });

          // Collect PDF chunks
          const chunks = [];
          doc.on("data", (chunk) => chunks.push(chunk));
          doc.on("end", () => resolve(Buffer.concat(chunks)));

          // ===== HEADER SECTION =====
          // Company Logo/Name
          doc
            .fontSize(24)
            .font("Helvetica-Bold")
            .fillColor("#0D9488")
            .text("BD Programming", { align: "center" });

          doc.moveDown(0.5);
          doc
            .fontSize(14)
            .font("Helvetica")
            .fillColor("#4B5563")
            .text("Official Payment Receipt", { align: "center" });

          doc.moveDown(0.5);
          doc
            .fontSize(10)
            .fillColor("#6B7280")
            .text("1212 East Shewrapara, Mirpur, Dhaka 1216, Bangladesh", {
              align: "center",
            });

          // Decorative line
          doc.moveDown(1);
          doc
            .strokeColor("#0D9488")
            .lineWidth(2)
            .moveTo(50, doc.y)
            .lineTo(550, doc.y)
            .stroke();

          doc.moveDown(1);

          // ===== RECEIPT INFO =====
          doc.fontSize(10).font("Helvetica").fillColor("#374151");

          // Receipt Number and Date in two columns
          const startY = doc.y;

          // Left column - Receipt Info
          doc
            .text("Receipt Number:", 50, startY, { continued: true })
            .font("Helvetica-Bold")
            .text(` ${payment.merchantInvoiceNumber}`, { continued: false });

          doc.moveDown(0.5);
          doc
            .font("Helvetica")
            .text("Date:", 50, doc.y, { continued: true })
            .font("Helvetica-Bold")
            .text(` ${formatDate(payment.updatedAt || payment.createdAt)}`);

          // Right column - Status
          doc
            .font("Helvetica")
            .text("Status:", 350, startY, { continued: true })
            .font("Helvetica-Bold")
            .fillColor("#10B981")
            .text(" PAID ✓");

          doc.moveDown(2);

          // ===== STUDENT INFORMATION SECTION =====
          doc
            .fontSize(14)
            .font("Helvetica-Bold")
            .fillColor("#0D9488")
            .text("Student Information");

          doc.moveDown(0.5);

          // Student details in a box
          doc.rect(50, doc.y - 5, 500, 70).fillAndStroke("#F3F4F6", "#E5E7EB");

          const studentInfoY = doc.y;
          doc.fontSize(11).font("Helvetica").fillColor("#1F2937");

          // Student Name
          doc
            .text("Full Name:", 70, studentInfoY + 10, { continued: true })
            .font("Helvetica-Bold")
            .text(` ${user?.name || "N/A"}`);

          doc.moveDown(0.8);
          // Email
          doc
            .font("Helvetica")
            .text("Email:", 70, doc.y, { continued: true })
            .font("Helvetica-Bold")
            .text(` ${user?.email || "N/A"}`);

          doc.moveDown(0.8);
          // Student ID
          doc
            .font("Helvetica")
            .text("Student ID:", 70, doc.y, { continued: true })
            .font("Helvetica-Bold")
            .text(` ${user?.uniqueId || "N/A"}`);

          doc.moveDown(2);

          // ===== PAYMENT DETAILS SECTION =====
          doc
            .fontSize(14)
            .font("Helvetica-Bold")
            .fillColor("#0D9488")
            .text("Payment Details");

          doc.moveDown(0.5);

          // Create a table for payment details
          const tableTop = doc.y;
          const col1 = 70;
          const col2 = 250;
          const col3 = 400;

          // Table Header
          doc
            .fontSize(10)
            .font("Helvetica-Bold")
            .fillColor("#374151")
            .text("Description", col1, tableTop)
            .text("Reference", col2, tableTop)
            .text("Amount", col3, tableTop);

          doc.moveDown(0.5);
          doc
            .strokeColor("#D1D5DB")
            .lineWidth(1)
            .moveTo(50, doc.y)
            .lineTo(550, doc.y)
            .stroke();

          doc.moveDown(0.5);

          // Table Row
          const rowY = doc.y;
          doc
            .font("Helvetica")
            .fillColor("#1F2937")
            .text("Course Enrollment", col1, rowY)
            .text(
              `TXN: ${payment.trxID || payment.paymentData?.trxID || "N/A"}`,
              col2,
              rowY,
            )
            .font("Helvetica-Bold")
            .fillColor("#0D9488")
            .text(`৳${(payment.amount || 0).toLocaleString()}`, col3, rowY);

          doc.moveDown(1.5);

          // ===== COURSE INFORMATION SECTION =====
          doc
            .fontSize(14)
            .font("Helvetica-Bold")
            .fillColor("#0D9488")
            .text("Course Information");

          doc.moveDown(0.5);

          // Course details in a grid
          const courseStartY = doc.y;
          doc.fontSize(11).font("Helvetica").fillColor("#1F2937");

          // Left column
          doc
            .text("Course:", 70, courseStartY, { continued: true })
            .font("Helvetica-Bold")
            .text(` ${course?.title || "N/A"}`, { continued: false });

          doc.moveDown(0.8);
          doc
            .font("Helvetica")
            .text("Duration:", 70, doc.y, { continued: true })
            .font("Helvetica-Bold")
            .text(` ${course?.duration || "N/A"}`);

          doc.moveDown(0.8);
          doc
            .font("Helvetica")
            .text("Level:", 70, doc.y, { continued: true })
            .font("Helvetica-Bold")
            .text(` ${course?.level || "N/A"}`);

          // Right column
          const rightColY = courseStartY;
          doc
            .font("Helvetica")
            .text("Access:", 350, rightColY, { continued: true })
            .font("Helvetica-Bold")
            .text(" Lifetime Access");

          doc.moveDown(0.8);
          doc
            .font("Helvetica")
            .text("Certificate:", 350, doc.y, { continued: true })
            .font("Helvetica-Bold")
            .fillColor("#0D9488")
            .text(" Available upon completion");

          doc.moveDown(2);

          // ===== SUMMARY SECTION =====
          doc
            .fontSize(14)
            .font("Helvetica-Bold")
            .fillColor("#0D9488")
            .text("Payment Summary");

          doc.moveDown(0.5);

          // Summary box
          doc.rect(350, doc.y - 5, 200, 80).fillAndStroke("#F3F4F6", "#E5E7EB");

          const summaryY = doc.y;
          doc.fontSize(11).font("Helvetica").fillColor("#1F2937");

          doc
            .text("Subtotal:", 370, summaryY + 10, { continued: true })
            .font("Helvetica-Bold")
            .text(` ৳${(payment.amount || 0).toLocaleString()}`);

          doc.moveDown(0.8);
          doc
            .font("Helvetica")
            .text("VAT (0%):", 370, doc.y, { continued: true })
            .font("Helvetica-Bold")
            .text(" ৳0");

          doc.moveDown(0.8);
          doc
            .font("Helvetica-Bold")
            .fillColor("#0D9488")
            .fontSize(12)
            .text("Total Paid:", 370, doc.y, { continued: true })
            .text(` ৳${(payment.amount || 0).toLocaleString()}`);

          doc.moveDown(3);

          // ===== FOOTER =====
          doc
            .fontSize(9)
            .font("Helvetica")
            .fillColor("#6B7280")
            .text(
              "This is a computer generated receipt. No signature required.",
              50,
              700,
              { align: "center" },
            )
            .text(
              "For any queries, contact: teams.rcsbd@gmail.com | +880 1715697780",
              { align: "center" },
            )
            .text(
              `© ${new Date().getFullYear()} Reliable Code Solutions. All rights reserved.`,
              { align: "center" },
            );

          // Add watermark/stamp
          doc.save();
          doc
            .fontSize(60)
            .font("Helvetica-Bold")
            .fillColor("#0D9488")
            .fillOpacity(0.1)
            .rotate(-45, { origin: [300, 400] })
            .text("PAID", 200, 350);
          doc.restore();

          // Finalize the PDF
          doc.end();
        } catch (error) {
          reject(error);
        }
      });
    };

    // ===== UPDATED PDF RECEIPT DOWNLOAD ROUTE =====
    api.get(
      "/payments/receipt/:merchantInvoiceNumber",
      authenticateToken,
      async (req, res) => {
        try {
          const { merchantInvoiceNumber } = req.params;
          const userId = req.user.userId;

          logger.log("📄 Generating PDF receipt for:", {
            merchantInvoiceNumber,
            userId,
          });

          // Find payment
          const payment = await paymentCollection.findOne({
            merchantInvoiceNumber,
            userId: new ObjectId(userId),
          });

          if (!payment) {
            logger.error("❌ Payment not found:", merchantInvoiceNumber);
            return res
              .status(404)
              .json({ success: false, message: "Payment not found" });
          }

          logger.log("✅ Payment found:", {
            id: payment._id,
            amount: payment.amount,
            trxID: payment.trxID,
          });

          // Get course details
          const course = await courseCollection.findOne({
            _id: payment.courseId,
          });
          if (!course) {
            logger.error("❌ Course not found:", payment.courseId);
          }

          // Get user details
          const user = await userCollection.findOne({ _id: userId });
          if (!user) {
            logger.error("❌ User not found:", userId);
          }

          logger.log("✅ User and course found:", {
            userName: user?.name,
            userEmail: user?.email,
            courseTitle: course?.title,
          });

          try {
            // Generate PDF
            const pdfBuffer = await generatePDFReceipt(payment, user, course);

            logger.log(
              "✅ PDF generated successfully, size:",
              pdfBuffer.length,
              "bytes",
            );

            // Send PDF
            res.setHeader("Content-Type", "application/pdf");
            res.setHeader(
              "Content-Disposition",
              `attachment; filename=receipt-${merchantInvoiceNumber}.pdf`,
            );
            res.setHeader("Content-Length", pdfBuffer.length);
            res.setHeader("Cache-Control", "no-cache");

            // Send the PDF buffer
            res.send(pdfBuffer);
          } catch (pdfError) {
            logger.error("❌ PDF generation error:", pdfError);

            // Fallback to text receipt if PDF fails
            const fallbackReceipt = `
===========================================
      BD Programming
      OFFICIAL PAYMENT RECEIPT
===========================================

Receipt No: ${payment.merchantInvoiceNumber}
Date: ${new Date(payment.updatedAt || payment.createdAt).toLocaleDateString("en-BD")}

-------------------------------------------
STUDENT INFORMATION
-------------------------------------------
Name: ${user?.name || "N/A"}
Email: ${user?.email || "N/A"}

-------------------------------------------
PAYMENT DETAILS
-------------------------------------------
Transaction ID: ${payment.trxID || payment.paymentData?.trxID || "N/A"}
Amount: ৳${payment.amount?.toLocaleString() || "0"}

-------------------------------------------
COURSE INFORMATION
-------------------------------------------
Course: ${course?.title || "N/A"}

===========================================
      `;

            res.setHeader("Content-Type", "text/plain");
            res.setHeader(
              "Content-Disposition",
              `attachment; filename=receipt-${merchantInvoiceNumber}.txt`,
            );
            res.send(fallbackReceipt);
          }
        } catch (error) {
          logger.error("❌ Download receipt error:", error);
          res
            .status(500)
            .json({ success: false, message: "Failed to download receipt" });
        }
      },
    );

    // ===== UPDATE THE PAYMENT STATUS ROUTE =====

    api.get(
      "/payments/status/:merchantInvoiceNumber",
      authenticateToken,
      async (req, res) => {
        try {
          const { merchantInvoiceNumber } = req.params;
          const userId = req.user.userId;

          logger.log("🔍 Checking payment status for:", merchantInvoiceNumber);

          // Find payment
          const payment = await paymentCollection.findOne({
            merchantInvoiceNumber,
            userId: new ObjectId(userId),
          });

          if (!payment) {
            return res
              .status(404)
              .json({ success: false, message: "Payment not found" });
          }

          // Get user details
          const user = await userCollection.findOne(
            { _id: new ObjectId(userId) },
            { projection: { name: 1, email: 1, uniqueId: 1 } },
          );

          // Get course details
          const course = await courseCollection.findOne(
            { _id: payment.courseId },
            { projection: { title: 1, duration: 1, level: 1 } },
          );

          // Prepare response with proper student data
          const responseData = {
            success: true,
            payment: {
              _id: payment._id,
              merchantInvoiceNumber: payment.merchantInvoiceNumber,
              amount: payment.amount,
              status: payment.status,
              trxID: payment.trxID || payment.paymentData?.trxID || "N/A",
              createdAt: payment.createdAt,
              updatedAt: payment.updatedAt,
              // Student information
              studentName: user?.name || "Student",
              studentEmail: user?.email || "student@example.com",
              studentId: user?.uniqueId || "N/A",
              // Course information
              courseTitle: course?.title || "Course",
              courseDuration: course?.duration || "Self-paced",
              courseLevel: course?.level || "All Levels",
            },
          };

          logger.log("✅ Sending payment status response with student:", {
            name: responseData.payment.studentName,
            email: responseData.payment.studentEmail,
          });

          res.json(responseData);
        } catch (error) {
          logger.error("❌ Payment status error:", error);
          res
            .status(500)
            .json({ success: false, message: "Failed to get payment status" });
        }
      },
    );

    // ============= TESTIMONIALS API =============
    // PUBLIC: Get approved testimonials for homepage
    // GET random testimonials
    api.get("/testimonials/random", async (req, res) => {
      try {
        const { count = 5 } = req.query;

        // Using MongoDB aggregation to get random documents
        const testimonials = await db
          .collection("testimonials")
          .aggregate([
            { $match: { status: "active", isApproved: true } },
            { $sample: { size: parseInt(count) } },
          ])
          .toArray();

        res.json({
          success: true,
          testimonials,
          count: testimonials.length,
        });
      } catch (error) {
        logger.error("Error fetching random testimonials:", error);
        res.status(500).json({ message: "Server error" });
      }
    });

    api.get("/testimonials", async (req, res) => {
      try {
        const { limit = 6, featured } = req.query;

        let query = {
          status: "active",
          isApproved: true,
        };

        if (featured === "true") {
          query.isFeatured = true;
        }

        const testimonials = await db
          .collection("testimonials")
          .find(query)
          .sort({ createdAt: -1 })
          .limit(parseInt(limit))
          .toArray();

        res.json({
          success: true,
          testimonials,
          total: testimonials.length,
        });
      } catch (error) {
        logger.error("Error fetching testimonials:", error);
        res.status(500).json({ message: "Server error" });
      }
    });

    // PUBLIC: Submit a testimonial (for registered users)
    api.post("/testimonials", authenticateToken, async (req, res) => {
      try {
        const { comment, rating, course } = req.body;

        // Get user details
        const user = await db
          .collection("users")
          .findOne({ _id: new ObjectId(req.user.userId) });

        if (!user) {
          return res.status(404).json({ message: "User not found" });
        }

        const testimonial = {
          name: user.name,
          role: user.role === "student" ? "Student" : `${user.role} Student`,
          avatar: user.name?.charAt(0).toUpperCase() || "S",
          comment,
          rating: parseInt(rating),
          course: course || null,
          userId: user._id,
          isApproved: false, // Requires admin approval
          isFeatured: false,
          status: "pending",
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const result = await db
          .collection("testimonials")
          .insertOne(testimonial);

        res.status(201).json({
          success: true,
          message: "Testimonial submitted for review",
          testimonialId: result.insertedId,
        });
      } catch (error) {
        logger.error("Error submitting testimonial:", error);
        res.status(500).json({ message: "Server error" });
      }
    });

    // ADMIN: Get all testimonials with pagination and filters
    api.get(
      "/admin/testimonials",
      authenticateToken,
      isAdmin,
      async (req, res) => {
        try {
          const {
            page = 1,
            limit = 10,
            status,
            isApproved,
            search,
          } = req.query;

          const skip = (parseInt(page) - 1) * parseInt(limit);
          let query = {};

          if (status) query.status = status;
          if (isApproved !== undefined)
            query.isApproved = isApproved === "true";

          if (search) {
            query.$or = [
              { name: { $regex: search, $options: "i" } },
              { comment: { $regex: search, $options: "i" } },
            ];
          }

          const testimonials = await db
            .collection("testimonials")
            .find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .toArray();

          const total = await db
            .collection("testimonials")
            .countDocuments(query);

          res.json({
            success: true,
            testimonials,
            pagination: {
              page: parseInt(page),
              limit: parseInt(limit),
              total,
              pages: Math.ceil(total / parseInt(limit)),
            },
          });
        } catch (error) {
          logger.error("Error fetching admin testimonials:", error);
          res.status(500).json({ message: "Server error" });
        }
      },
    );

    // ADMIN: Update testimonial status/approval
    api.put(
      "/admin/testimonials/:id",
      authenticateToken,
      isAdmin,
      async (req, res) => {
        try {
          const { id } = req.params;
          const {
            status,
            isApproved,
            isFeatured,
            comment,
            rating,
            name,
            role,
          } = req.body;

          const updateData = {
            updatedAt: new Date(),
          };

          if (status !== undefined) updateData.status = status;
          if (isApproved !== undefined) updateData.isApproved = isApproved;
          if (isFeatured !== undefined) updateData.isFeatured = isFeatured;
          if (comment !== undefined) updateData.comment = comment;
          if (rating !== undefined) updateData.rating = parseInt(rating);
          if (name !== undefined) updateData.name = name;
          if (role !== undefined) updateData.role = role;

          const result = await db
            .collection("testimonials")
            .updateOne({ _id: new ObjectId(id) }, { $set: updateData });

          if (result.matchedCount === 0) {
            return res.status(404).json({ message: "Testimonial not found" });
          }

          res.json({
            success: true,
            message: "Testimonial updated successfully",
          });
        } catch (error) {
          logger.error("Error updating testimonial:", error);
          res.status(500).json({ message: "Server error" });
        }
      },
    );

    // ADMIN: Delete testimonial
    api.delete(
      "/admin/testimonials/:id",
      authenticateToken,
      isAdmin,
      async (req, res) => {
        try {
          const { id } = req.params;

          const result = await db.collection("testimonials").deleteOne({
            _id: new ObjectId(id),
          });

          if (result.deletedCount === 0) {
            return res.status(404).json({ message: "Testimonial not found" });
          }

          res.json({
            success: true,
            message: "Testimonial deleted successfully",
          });
        } catch (error) {
          logger.error("Error deleting testimonial:", error);
          res.status(500).json({ message: "Server error" });
        }
      },
    );

    // ADMIN: Bulk actions on testimonials
    api.post(
      "/admin/testimonials/bulk",
      authenticateToken,
      isAdmin,
      async (req, res) => {
        try {
          const { action, testimonialIds, data } = req.body;

          if (!testimonialIds || testimonialIds.length === 0) {
            return res
              .status(400)
              .json({ message: "No testimonials selected" });
          }

          const objectIds = testimonialIds.map((id) => new ObjectId(id));
          let updateData = {};

          switch (action) {
            case "approve":
              updateData = {
                isApproved: true,
                status: "active",
                updatedAt: new Date(),
              };
              break;
            case "reject":
              updateData = {
                isApproved: false,
                status: "rejected",
                updatedAt: new Date(),
              };
              break;
            case "feature":
              updateData = { isFeatured: true, updatedAt: new Date() };
              break;
            case "unfeature":
              updateData = { isFeatured: false, updatedAt: new Date() };
              break;
            case "delete":
              const result = await db.collection("testimonials").deleteMany({
                _id: { $in: objectIds },
              });
              return res.json({
                success: true,
                message: `Deleted ${result.deletedCount} testimonials`,
              });
            default:
              return res.status(400).json({ message: "Invalid action" });
          }

          const result = await db
            .collection("testimonials")
            .updateMany({ _id: { $in: objectIds } }, { $set: updateData });

          res.json({
            success: true,
            message: `Updated ${result.modifiedCount} testimonials`,
          });
        } catch (error) {
          logger.error("Error in bulk action:", error);
          res.status(500).json({ message: "Server error" });
        }
      },
    );

    // Get all contacts (admin only)
    api.get("/contacts", authenticateToken, isAdmin, async (req, res) => {
      try {
        const { page = 1, limit = 10, status } = req.query;
        const query = status ? { status } : {};

        const contactsList = await contactCollection
          .find(query)
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(parseInt(limit))
          .toArray();

        const total = await contactCollection.countDocuments(query);

        res.json({
          contacts: contactsList,
          total,
          page: parseInt(page),
          totalPages: Math.ceil(total / limit),
        });
      } catch (error) {
        logger.error("Error fetching contacts:", error);
        res.status(500).json({ error: "Failed to fetch contacts" });
      }
    });

    // Get single contact by ID (admin only)
    api.get("/contacts/:id", authenticateToken, isAdmin, async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: "Invalid contact ID format" });
        }

        const db = client.db("lmsDB");
        const contacts = db.collection("contacts");

        const contact = await contacts.findOne({ _id: new ObjectId(id) });

        if (!contact) {
          return res.status(404).json({ error: "Contact not found" });
        }

        res.json({ success: true, contact });
      } catch (error) {
        logger.error("Error fetching contact:", error);
        res.status(500).json({ error: "Failed to fetch contact" });
      }
    });

    // Update contact status (admin only)
    api.patch("/contacts/:id", authenticateToken, isAdmin, async (req, res) => {
      try {
        const { id } = req.params;
        const { status, response } = req.body;

        const updateData = {
          ...(status && { status }),
          ...(response && { response, respondedAt: new Date() }),
        };

        const result = await contactCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updateData },
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({ error: "Contact not found" });
        }

        res.json({ success: true, message: "Contact updated successfully" });
      } catch (error) {
        logger.error("Error updating contact:", error);
        res.status(500).json({ error: "Failed to update contact" });
      }
    });

    // Bulk actions on contacts (admin only)
    api.post("/contacts/bulk", authenticateToken, isAdmin, async (req, res) => {
      try {
        const { action, contactIds } = req.body;

        if (!contactIds || contactIds.length === 0) {
          return res.status(400).json({ error: "No contacts selected" });
        }

        const objectIds = contactIds.map((id) => new ObjectId(id));

        let result;
        switch (action) {
          case "markResponded":
            result = await contactCollection.updateMany(
              { _id: { $in: objectIds } },
              { $set: { status: "responded", updatedAt: new Date() } },
            );
            break;
          case "markClosed":
            result = await contactCollection.updateMany(
              { _id: { $in: objectIds } },
              { $set: { status: "closed", updatedAt: new Date() } },
            );
            break;
          case "delete":
            result = await contactCollection.deleteMany({
              _id: { $in: objectIds },
            });
            break;
          default:
            return res.status(400).json({ error: "Invalid action" });
        }

        res.json({
          success: true,
          message: `Bulk action '${action}' completed`,
          modifiedCount: result.modifiedCount || result.deletedCount,
        });
      } catch (error) {
        logger.error("Error in bulk action:", error);
        res.status(500).json({ error: "Failed to perform bulk action" });
      }
    });

    // Send email response
    api.post(
      "/contacts/:id/send-email",
      authenticateToken,
      isAdmin,
      async (req, res) => {
        try {
          const { id } = req.params;
          const { response, subject } = req.body;

          if (!ObjectId.isValid(id)) {
            return res.status(400).json({ error: "Invalid contact ID format" });
          }

          const db = client.db("lmsDB");
          const contacts = db.collection("contacts");

          const contact = await contacts.findOne({ _id: new ObjectId(id) });

          if (!contact) {
            return res.status(404).json({ error: "Contact not found" });
          }

          // Send email using your existing transporter
          const mailOptions = {
            from: process.env.EMAIL_USER,
            to: contact.email,
            subject: subject || `Re: ${contact.subject}`,
            html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #4f46e5;">Response to Your Inquiry</h2>
          <p>Dear ${contact.name},</p>
          <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
            ${response.replace(/\n/g, "<br/>")}
          </div>
          <p>Best regards,<br>LMS Support Team</p>
        </div>
      `,
          };

          await transporter.sendMail(mailOptions);

          // Update contact with response and mark as responded
          await contacts.updateOne(
            { _id: new ObjectId(id) },
            {
              $set: {
                response,
                status: "responded",
                respondedAt: new Date(),
                updatedAt: new Date(),
              },
            },
          );

          res.json({ success: true, message: "Email sent successfully" });
        } catch (error) {
          logger.error("Error sending email:", error);
          res.status(500).json({ error: "Failed to send email" });
        }
      },
    );

    // Delete contact
    api.delete(
      "/contacts/:id",
      authenticateToken,
      isAdmin,
      async (req, res) => {
        try {
          const { id } = req.params;

          if (!ObjectId.isValid(id)) {
            return res.status(400).json({ error: "Invalid contact ID format" });
          }

          const db = client.db("lmsDB");
          const contacts = db.collection("contacts");

          const result = await contacts.deleteOne({ _id: new ObjectId(id) });

          if (result.deletedCount === 0) {
            return res.status(404).json({ error: "Contact not found" });
          }

          res.json({ success: true, message: "Contact deleted successfully" });
        } catch (error) {
          logger.error("Error deleting contact:", error);
          res.status(500).json({ error: "Failed to delete contact" });
        }
      },
    );

    // ============= REVIEW API ROUTES =============

    // POST - Create a new review (Authenticated users only)
    api.post(
      "/courses/:courseId/reviews",
      authenticateToken,
      async (req, res) => {
        try {
          const { courseId } = req.params;
          const userId = req.user.userId;
          const { rating, comment, title } = req.body;

          // Validate input
          if (!rating || rating < 1 || rating > 5) {
            return res.status(400).json({
              success: false,
              message: "Rating must be between 1 and 5",
            });
          }

          if (!comment || comment.trim().length < 10) {
            return res.status(400).json({
              success: false,
              message: "Review comment must be at least 10 characters",
            });
          }

          // Check if user is enrolled in the course
          const user = await userCollection.findOne({
            _id: new ObjectId(userId),
            "enrolledCourses.courseId": new ObjectId(courseId),
          });

          if (!user) {
            return res.status(403).json({
              success: false,
              message: "You must be enrolled in this course to leave a review",
            });
          }

          // Check if user already reviewed this course
          const existingReview = await reviewCollection.findOne({
            courseId: new ObjectId(courseId),
            userId: new ObjectId(userId),
          });

          if (existingReview) {
            return res.status(400).json({
              success: false,
              message: "You have already reviewed this course",
            });
          }

          // Create review
          const review = {
            _id: new ObjectId(),
            courseId: new ObjectId(courseId),
            userId: new ObjectId(userId),
            userName: user.name,
            userAvatar: user.profile?.photo || null,
            rating: parseInt(rating),
            title: title || "",
            comment: comment.trim(),
            isApproved: false, // Requires admin approval
            isFeatured: false,
            helpful: 0,
            reported: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          };

          await reviewCollection.insertOne(review);

          // Update course rating stats
          await updateCourseRatingStats(courseId);

          res.status(201).json({
            success: true,
            message:
              "Review submitted successfully! It will be visible after approval.",
            review,
          });
        } catch (error) {
          logger.error("Create review error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to submit review",
            error:
              process.env.NODE_ENV === "development"
                ? error.message
                : undefined,
          });
        }
      },
    );

    // GET - Get all reviews for a course (Public)
    api.get("/courses/:courseId/reviews", async (req, res) => {
      try {
        const { courseId } = req.params;
        const { page = 1, limit = 10, sort = "recent" } = req.query;

        const skip = (parseInt(page) - 1) * parseInt(limit);

        let sortOptions = { createdAt: -1 };
        if (sort === "highest") sortOptions = { rating: -1, createdAt: -1 };
        if (sort === "lowest") sortOptions = { rating: 1, createdAt: -1 };
        if (sort === "helpful") sortOptions = { helpful: -1, createdAt: -1 };

        const reviews = await reviewCollection
          .find({
            courseId: new ObjectId(courseId),
            isApproved: true, // Only show approved reviews
          })
          .sort(sortOptions)
          .skip(skip)
          .limit(parseInt(limit))
          .toArray();

        const total = await reviewCollection.countDocuments({
          courseId: new ObjectId(courseId),
          isApproved: true,
        });

        // Get rating distribution
        const distribution = await reviewCollection
          .aggregate([
            { $match: { courseId: new ObjectId(courseId), isApproved: true } },
            { $group: { _id: "$rating", count: { $sum: 1 } } },
            { $sort: { _id: -1 } },
          ])
          .toArray();

        const ratingCounts = {
          5: 0,
          4: 0,
          3: 0,
          2: 0,
          1: 0,
        };

        distribution.forEach((item) => {
          ratingCounts[item._id] = item.count;
        });

        res.json({
          success: true,
          reviews,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            pages: Math.ceil(total / parseInt(limit)),
          },
          distribution: ratingCounts,
        });
      } catch (error) {
        logger.error("Get reviews error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch reviews",
        });
      }
    });

    // GET - Check if user can review (Authenticated)
    api.get(
      "/courses/:courseId/can-review",
      authenticateToken,
      async (req, res) => {
        try {
          const { courseId } = req.params;
          const userId = req.user.userId;

          // Check if enrolled
          const user = await userCollection.findOne({
            _id: new ObjectId(userId),
            "enrolledCourses.courseId": new ObjectId(courseId),
          });

          if (!user) {
            return res.json({
              success: true,
              canReview: false,
              reason: "not_enrolled",
            });
          }

          // Check if already reviewed
          const existingReview = await reviewCollection.findOne({
            courseId: new ObjectId(courseId),
            userId: new ObjectId(userId),
          });

          if (existingReview) {
            return res.json({
              success: true,
              canReview: false,
              reason: "already_reviewed",
              review: existingReview,
            });
          }

          res.json({
            success: true,
            canReview: true,
          });
        } catch (error) {
          logger.error("Check review status error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to check review status",
          });
        }
      },
    );

    // PATCH - Update review (Authenticated - own review only)
    api.patch("/reviews/:reviewId", authenticateToken, async (req, res) => {
      try {
        const { reviewId } = req.params;
        const userId = req.user.userId;
        const { rating, comment, title } = req.body;

        const review = await reviewCollection.findOne({
          _id: new ObjectId(reviewId),
          userId: new ObjectId(userId),
        });

        if (!review) {
          return res.status(404).json({
            success: false,
            message: "Review not found or unauthorized",
          });
        }

        const updateData = {
          ...(rating && { rating: parseInt(rating) }),
          ...(comment && { comment: comment.trim() }),
          ...(title && { title }),
          updatedAt: new Date(),
          isApproved: false, // Requires re-approval after edit
        };

        await reviewCollection.updateOne(
          { _id: new ObjectId(reviewId) },
          { $set: updateData },
        );

        // Update course rating stats
        await updateCourseRatingStats(review.courseId);

        res.json({
          success: true,
          message: "Review updated successfully",
        });
      } catch (error) {
        logger.error("Update review error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to update review",
        });
      }
    });

    // DELETE - Delete review (Authenticated - own review only or Admin)
    api.delete("/reviews/:reviewId", authenticateToken, async (req, res) => {
      try {
        const { reviewId } = req.params;
        const userId = req.user.userId;
        const user = await userCollection.findOne({
          _id: new ObjectId(userId),
        });

        const query = { _id: new ObjectId(reviewId) };
        if (user.role !== "admin") {
          query.userId = new ObjectId(userId); // Non-admins can only delete their own
        }

        const review = await reviewCollection.findOne(query);

        if (!review) {
          return res.status(404).json({
            success: false,
            message: "Review not found or unauthorized",
          });
        }

        await reviewCollection.deleteOne({ _id: review._id });

        // Update course rating stats
        await updateCourseRatingStats(review.courseId);

        res.json({
          success: true,
          message: "Review deleted successfully",
        });
      } catch (error) {
        logger.error("Delete review error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to delete review",
        });
      }
    });

    // POST - Mark review as helpful
    api.post(
      "/reviews/:reviewId/helpful",
      authenticateToken,
      async (req, res) => {
        try {
          const { reviewId } = req.params;

          await reviewCollection.updateOne(
            { _id: new ObjectId(reviewId) },
            { $inc: { helpful: 1 } },
          );

          res.json({
            success: true,
            message: "Thank you for your feedback",
          });
        } catch (error) {
          logger.error("Helpful mark error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to mark as helpful",
          });
        }
      },
    );

    // Helper function to update course rating stats
    async function updateCourseRatingStats(courseId) {
      try {
        const stats = await reviewCollection
          .aggregate([
            { $match: { courseId: new ObjectId(courseId), isApproved: true } },
            {
              $group: {
                _id: null,
                averageRating: { $avg: "$rating" },
                totalReviews: { $sum: 1 },
                distribution: {
                  $push: "$rating",
                },
              },
            },
          ])
          .toArray();

        if (stats.length > 0) {
          const distribution = {
            5: 0,
            4: 0,
            3: 0,
            2: 0,
            1: 0,
          };

          // Calculate distribution
          const allReviews = await reviewCollection
            .find({
              courseId: new ObjectId(courseId),
              isApproved: true,
            })
            .toArray();

          allReviews.forEach((review) => {
            distribution[review.rating]++;
          });

          await courseCollection.updateOne(
            { _id: new ObjectId(courseId) },
            {
              $set: {
                "stats.averageRating": parseFloat(
                  stats[0].averageRating.toFixed(1),
                ),
                "stats.totalReviews": stats[0].totalReviews,
                "reviews.distribution": distribution,
              },
            },
          );
        } else {
          // No reviews
          await courseCollection.updateOne(
            { _id: new ObjectId(courseId) },
            {
              $set: {
                "stats.averageRating": 0,
                "stats.totalReviews": 0,
                "reviews.distribution": { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 },
              },
            },
          );
        }
      } catch (error) {
        logger.error("Update course rating stats error:", error);
      }
    }

    // =============Blog ROUTES =============

    // Get all approved/published posts (Public)
    api.get("/posts", async (req, res) => {
      try {
        const { page = 1, limit = 10, category, search } = req.query;

        const query = { status: "published" };

        // Category filter
        if (category && category !== "all") {
          // query.category = category;
          query.category = { $regex: new RegExp(`^${category}$`, "i") };
        }

        // Search filter - Enhanced with tags search
        if (search && search.trim()) {
          const searchRegex = new RegExp(search.trim(), "i");
          query.$or = [
            { title: searchRegex },
            { content: searchRegex },
            { excerpt: searchRegex },
            { tags: { $in: [searchRegex] } }, // ✅ ADDED: Search in tags
          ];
        }

        const posts = await postCollection
          .find(query)
          .sort({ publishedAt: -1, createdAt: -1 })
          .skip((parseInt(page) - 1) * parseInt(limit))
          .limit(parseInt(limit))
          .toArray();

        const total = await postCollection.countDocuments(query);

        // Format posts for frontend
        const formattedPosts = posts.map((post) => ({
          ...post,
          _id: post._id.toString(),
          views: post.views || 0,
          likes: post.likes || 0,
          createdAt: post.createdAt
            ? new Date(post.createdAt).toISOString()
            : new Date().toISOString(),
        }));

        res.json({
          success: true,
          posts: formattedPosts,
          currentPage: parseInt(page),
          totalPages: Math.ceil(total / parseInt(limit)),
          total,
        });
      } catch (error) {
        logger.error("Get posts error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch posts",
        });
      }
    });

    // Get single post by ID
    api.get("/posts/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const userId = req.user?.userId;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({
            success: false,
            message: "Invalid post ID format",
          });
        }

        const post = await db.collection("posts").findOne({
          _id: new ObjectId(id),
        });

        if (!post) {
          return res.status(404).json({
            success: false,
            message: "Post not found",
          });
        }

        // Check if user has permission to view this post
        // Allow if: post is published OR user is the author OR user is admin
        const isAuthor = post.authorId.toString() === userId;
        const isAdmin = req.user?.role === "admin";
        const isPublished = post.status === "published";

        if (!isPublished && !isAuthor && !isAdmin) {
          return res.status(404).json({
            success: false,
            message: "Post not found",
          });
        }

        // Format the response
        const formattedPost = {
          ...post,
          _id: post._id.toString(),
          createdAt: post.createdAt
            ? new Date(post.createdAt).toISOString()
            : new Date().toISOString(),
          updatedAt: post.updatedAt
            ? new Date(post.updatedAt).toISOString()
            : new Date().toISOString(),
        };

        // Only increment view count for published posts
        if (isPublished) {
          db.collection("posts")
            .updateOne({ _id: new ObjectId(id) }, { $inc: { views: 1 } })
            .catch((err) => console.error("Error incrementing views:", err));
        }

        res.json(formattedPost);
      } catch (error) {
        console.error("Error in GET /api/posts/:id:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch post",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // Get user's own posts (with all statuses)
    api.get("/my-posts", authenticateToken, async (req, res) => {
      try {
        const userId = req.user.userId;
        const { status, page = 1, limit = 10 } = req.query;

        const query = { authorId: new ObjectId(userId) };
        if (status && status !== "all") query.status = status;

        const posts = await postCollection
          .find(query)
          .sort({ createdAt: -1 })
          .skip((parseInt(page) - 1) * parseInt(limit))
          .limit(parseInt(limit))
          .toArray();

        const total = await postCollection.countDocuments(query);

        res.json({
          success: true,
          posts,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            totalPages: Math.ceil(total / parseInt(limit)),
          },
        });
      } catch (error) {
        logger.error("Get my posts error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch your posts",
        });
      }
    });

    // Create a new blog post (Anyone logged in can create, but needs approval)
    api.post("/posts", authenticateToken, async (req, res) => {
      try {
        const { title, content, excerpt, category, coverImage, tags } =
          req.body;
        const userId = req.user.userId;

        // Validate required fields
        if (!title || !content) {
          return res.status(400).json({
            success: false,
            message: "Title and content are required",
          });
        }

        // Get user details
        const user = await userCollection.findOne({
          _id: new ObjectId(userId),
        });

        if (!user) {
          return res.status(404).json({
            success: false,
            message: "User not found",
          });
        }

        // Create post with pending status (needs admin approval)
        const newPost = {
          title: title.trim(),
          content,
          excerpt: excerpt || content.substring(0, 160),
          category: category || "Uncategorized",
          coverImage: coverImage || null,
          tags: tags || [],
          authorId: new ObjectId(userId),
          authorName: user.name,
          authorEmail: user.email,
          authorRole: user.role, // student, instructor, or admin
          status: "pending", // pending, approved, rejected, published
          views: 0,
          likes: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
          // Admin review fields
          reviewedBy: null,
          reviewedAt: null,
          rejectionReason: null,
          publishedAt: null,
        };

        const result = await postCollection.insertOne(newPost);

        // Update user's blog stats
        await userCollection.updateOne(
          { _id: new ObjectId(userId) },
          {
            $inc: {
              "blogProfile.totalPosts": 1,
              "blogProfile.totalPendingPosts": 1,
            },
          },
        );

        // Notify admins about new post for approval
        const admins = await userCollection
          .find({ role: "admin" })
          .project({ _id: 1 })
          .toArray();

        if (admins.length > 0) {
          await notificationService.sendToMany(
            admins.map((a) => a._id),
            {
              type: "blog_post_pending",
              message: `📝 New blog post awaiting approval: "${title}"`,
              details: `Submitted by ${user.name} (${user.role})`,
              actionUrl: `/admin/posts/${result.insertedId}/review`,
            },
          );
        }

        logger.log(
          `✅ Post created: ${result.insertedId} by ${user.email} (status: pending)`,
        );

        res.status(201).json({
          success: true,
          message:
            "Your post has been submitted for review. It will be published once approved by an admin.",
          post: {
            ...newPost,
            _id: result.insertedId,
          },
        });
      } catch (error) {
        logger.error("Create post error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to create post",
          error:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });

    // Comments Routes
    api.get("/posts/:postId/comments", async (req, res) => {
      try {
        const { postId } = req.params;

        const comments = await db
          .collection("comments")
          .find({ postId, status: "approved" })
          .sort({ createdAt: -1 })
          .toArray();

        // Format dates and ensure user info is present
        const formattedComments = comments.map((comment) => ({
          _id: comment._id,
          author: comment.author,
          email: comment.email,
          content: comment.content,
          createdAt: comment.createdAt
            ? new Date(comment.createdAt).toISOString()
            : new Date().toISOString(),
        }));

        res.json(formattedComments);
      } catch (error) {
        console.error("Error fetching comments:", error);
        res.status(500).json({ error: error.message });
      }
    });

    // comment creation
    api.post("/comments", authenticateToken, async (req, res) => {
      try {
        const { postId, content } = req.body;
        const userId = req.user.userId;
        const userEmail = req.user.email;
        const userName = req.user.name;

        // Validate input
        if (!postId || !content) {
          return res.status(400).json({
            success: false,
            message: "Post ID and content are required",
          });
        }

        // Validate post exists
        if (!ObjectId.isValid(postId)) {
          return res.status(400).json({
            success: false,
            message: "Invalid post ID format",
          });
        }

        const post = await db.collection("posts").findOne({
          _id: new ObjectId(postId),
        });

        if (!post) {
          return res.status(404).json({
            success: false,
            message: "Post not found",
          });
        }

        // Create comment with authenticated user info
        const newComment = {
          postId,
          userId: new ObjectId(userId),
          author: userName,
          email: userEmail,
          content: content.trim(),
          status: "approved",
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const result = await db.collection("comments").insertOne(newComment);

        // Increment comment count on post (optional)
        await db
          .collection("posts")
          .updateOne(
            { _id: new ObjectId(postId) },
            { $inc: { commentsCount: 1 } },
          );

        // Notify post author (optional)
        if (post.authorId.toString() !== userId) {
          await notificationService.sendToUser(post.authorId, {
            type: "blog_comment",
            message: `💬 New comment on your post "${post.title}"`,
            details: `${userName} commented: ${content.substring(0, 100)}...`,
            actionUrl: `/posts/${postId}`,
          });
        }

        res.status(201).json({
          success: true,
          message: "Comment posted successfully",
          comment: {
            ...newComment,
            _id: result.insertedId,
            createdAt: newComment.createdAt.toISOString(),
          },
        });
      } catch (error) {
        console.error("Error creating comment:", error);
        res.status(500).json({
          success: false,
          message: "Failed to post comment",
        });
      }
    });

    // Apply for author status
    api.post("/users/apply-author", authenticateToken, async (req, res) => {
      try {
        const userId = req.user.userId;

        const result = await userCollection.updateOne(
          { _id: new ObjectId(userId) },
          {
            $set: {
              role: "pending_author",
              blogApplication: {
                appliedAt: new Date(),
                status: "pending",
                reviewedBy: null,
                reviewedAt: null,
              },
            },
          },
        );

        res.json({ success: true, message: "Application submitted" });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Add before the main update logic
    const validateProfileUpdate = (req, res, next) => {
      const { profile, blogProfile, blogSettings } = req.body;

      // Validate blogProfile structure if provided
      if (blogProfile) {
        const allowedFields = [
          "authorBio",
          "authorAvatar",
          "socialLinks",
          "authorBadges",
          "totalPosts",
          "totalLikes",
          "totalViews",
          "joinedAsAuthor",
        ];
        const invalidFields = Object.keys(blogProfile).filter(
          (key) => !allowedFields.includes(key),
        );

        if (invalidFields.length > 0) {
          return res.status(400).json({
            success: false,
            message: `Invalid blogProfile fields: ${invalidFields.join(", ")}`,
          });
        }

        // Validate socialLinks if present
        if (blogProfile.socialLinks) {
          const allowedSocialFields = [
            "personalWebsite",
            "twitter",
            "github",
            "linkedin",
          ];
          const invalidSocialFields = Object.keys(
            blogProfile.socialLinks,
          ).filter((key) => !allowedSocialFields.includes(key));

          if (invalidSocialFields.length > 0) {
            return res.status(400).json({
              success: false,
              message: `Invalid socialLinks fields: ${invalidSocialFields.join(", ")}`,
            });
          }
        }
      }

      // Validate blogSettings structure if provided
      if (blogSettings) {
        const allowedSettings = [
          "emailSubscribers",
          "commentNotifications",
          "allowGuestComments",
          "moderateComments",
        ];
        const invalidSettings = Object.keys(blogSettings).filter(
          (key) => !allowedSettings.includes(key),
        );

        if (invalidSettings.length > 0) {
          return res.status(400).json({
            success: false,
            message: `Invalid blogSettings fields: ${invalidSettings.join(", ")}`,
          });
        }
      }

      next();
    };

    // Update profile (enhanced for blog fields)
    api.put(
      "/users/profile",
      authenticateToken,
      validateProfileUpdate,
      async (req, res) => {
        try {
          const {
            name,
            profile, // Existing profile (education, address, etc.)
            blogProfile, // New: Blog author information
            blogSettings, // New: Blog preferences
          } = req.body;

          const userId = req.user.userId;

          // Validate at least one field is being updated
          if (!name && !profile && !blogProfile && !blogSettings) {
            return res.status(400).json({
              success: false,
              message: "No valid fields to update",
            });
          }

          // Build update object - only include fields that are provided
          const updateData = {
            updatedAt: new Date(),
          };

          // Add fields only if they exist in request
          if (name !== undefined && name !== null) {
            // Sanitize name
            const sanitizedName = name
              .trim()
              .replace(/[<>]/g, "")
              .slice(0, 100);
            if (sanitizedName.length === 0) {
              return res.status(400).json({
                success: false,
                message: "Name cannot be empty",
              });
            }
            updateData.name = sanitizedName;
          }

          if (profile !== undefined && profile !== null) {
            // Validate profile structure
            const allowedProfileFields = [
              "phone",
              "bio",
              "address",
              "education",
              "socialLinks",
            ];
            const invalidFields = Object.keys(profile).filter(
              (key) => !allowedProfileFields.includes(key),
            );

            if (
              invalidFields.length > 0 &&
              process.env.NODE_ENV !== "production"
            ) {
              logger.warn(
                `Unknown profile fields: ${invalidFields.join(", ")}`,
              );
            }

            updateData.profile = profile;
          }

          if (blogProfile !== undefined && blogProfile !== null) {
            // Validate blogProfile structure
            const allowedBlogFields = [
              "authorBio",
              "authorAvatar",
              "socialLinks",
              "authorBadges",
              "totalPosts",
              "totalLikes",
              "totalViews",
              "joinedAsAuthor",
            ];
            const invalidFields = Object.keys(blogProfile).filter(
              (key) => !allowedBlogFields.includes(key),
            );

            if (invalidFields.length > 0) {
              return res.status(400).json({
                success: false,
                message: `Invalid blogProfile fields: ${invalidFields.join(", ")}`,
              });
            }

            // Sanitize author bio
            if (blogProfile.authorBio) {
              blogProfile.authorBio = blogProfile.authorBio
                .trim()
                .slice(0, 500);
            }

            updateData.blogProfile = blogProfile;
          }

          if (blogSettings !== undefined && blogSettings !== null) {
            // Validate blogSettings structure
            const allowedSettings = [
              "emailSubscribers",
              "commentNotifications",
              "allowGuestComments",
              "moderateComments",
            ];
            const invalidSettings = Object.keys(blogSettings).filter(
              (key) => !allowedSettings.includes(key),
            );

            if (invalidSettings.length > 0) {
              return res.status(400).json({
                success: false,
                message: `Invalid blogSettings fields: ${invalidSettings.join(", ")}`,
              });
            }

            updateData.blogSettings = blogSettings;
          }

          // Fetch current user for initialization logic and permission checks
          const user = await userCollection.findOne({
            _id: new ObjectId(userId),
          });

          if (!user) {
            return res.status(404).json({
              success: false,
              message: "User not found",
            });
          }

          // Initialize blog fields if they don't exist (for first-time authors)
          if (
            !user.blogProfile &&
            (blogProfile !== undefined || blogSettings !== undefined)
          ) {
            // Only initialize if we're not replacing the entire object
            if (!updateData.blogProfile && blogProfile !== undefined) {
              updateData.blogProfile = {
                authorBio: user.profile?.bio || "",
                authorAvatar: "",
                socialLinks: {
                  personalWebsite: "",
                  ...(blogProfile.socialLinks || {}),
                },
                authorBadges: [],
                totalPosts: 0,
                totalLikes: 0,
                totalViews: 0,
                joinedAsAuthor: user.role === "author" ? new Date() : null,
                ...blogProfile, // Override with provided values
              };
            }

            if (!updateData.blogSettings && blogSettings !== undefined) {
              updateData.blogSettings = {
                emailSubscribers: false,
                commentNotifications: true,
                allowGuestComments: true,
                moderateComments: false,
                ...blogSettings, // Override with provided values
              };
            }
          }

          // Prevent non-authors from setting certain blog fields
          if (user.role !== "author" && user.role !== "admin") {
            if (updateData.blogProfile) {
              // Remove fields that shouldn't be set by non-authors
              delete updateData.blogProfile.totalPosts;
              delete updateData.blogProfile.totalLikes;
              delete updateData.blogProfile.totalViews;
              delete updateData.blogProfile.authorBadges;
            }
          }

          // Perform the update
          const result = await userCollection.updateOne(
            { _id: new ObjectId(userId) },
            { $set: updateData },
          );

          // Check if update was successful
          if (result.matchedCount === 0) {
            return res.status(404).json({
              success: false,
              message: "User not found",
            });
          }

          // Fetch updated user to return full profile
          const updatedUser = await userCollection.findOne({
            _id: new ObjectId(userId),
          });

          if (!updatedUser) {
            return res.status(404).json({
              success: false,
              message: "User not found after update",
            });
          }

          // Remove sensitive data
          const {
            password,
            emailVerificationToken,
            ...userWithoutSensitiveData
          } = updatedUser;

          // Log success (but don't expose sensitive info)
          logger.log(`Profile updated for user: ${userId}`);

          res.json({
            success: true,
            message: "Profile updated successfully",
            user: userWithoutSensitiveData,
          });
        } catch (error) {
          logger.error("Update profile error:", error);

          // Handle specific MongoDB errors
          if (error.code === 121) {
            // Document validation error
            return res.status(400).json({
              success: false,
              message: "Invalid data format",
            });
          }

          res.status(500).json({
            success: false,
            message: "Failed to update profile",
            error:
              process.env.NODE_ENV === "development"
                ? error.message
                : undefined,
          });
        }
      },
    );

    // Apply for author status
    api.post("/users/apply-author", authenticateToken, async (req, res) => {
      try {
        const userId = req.user.userId;

        const result = await userCollection.updateOne(
          { _id: new ObjectId(userId) },
          {
            $set: {
              role: "pending_author",
              blogApplication: {
                appliedAt: new Date(),
                status: "pending",
                reviewedBy: null,
                reviewedAt: null,
              },
            },
          },
        );

        res.json({ success: true, message: "Application submitted" });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // ============= ADMIN POST MANAGEMENT =============

    // Get all posts for admin review
    api.get("/admin/posts", authenticateToken, async (req, res) => {
      try {
        // Check if user is admin
        const user = await userCollection.findOne({
          _id: new ObjectId(req.user.userId),
        });

        if (user.role !== "admin") {
          return res.status(403).json({
            success: false,
            message: "Admin access required",
          });
        }

        const { status = "pending", page = 1, limit = 20, author } = req.query;

        const query = {};
        if (status !== "all") query.status = status;
        if (author && ObjectId.isValid(author))
          query.authorId = new ObjectId(author);

        const posts = await postCollection
          .find(query)
          .sort({ createdAt: -1 })
          .skip((parseInt(page) - 1) * parseInt(limit))
          .limit(parseInt(limit))
          .toArray();

        const total = await postCollection.countDocuments(query);

        // Get author details for each post
        const postsWithAuthor = await Promise.all(
          posts.map(async (post) => {
            const author = await userCollection.findOne(
              { _id: post.authorId },
              { projection: { name: 1, email: 1, role: 1, profile: 1 } },
            );
            return { ...post, authorDetails: author };
          }),
        );

        res.json({
          success: true,
          posts: postsWithAuthor,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            totalPages: Math.ceil(total / parseInt(limit)),
          },
        });
      } catch (error) {
        logger.error("Get admin posts error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch posts",
        });
      }
    });

    // Approve a post (Admin only)
    api.patch(
      "/admin/posts/:postId/approve",
      authenticateToken,
      async (req, res) => {
        try {
          // Check if user is admin
          const user = await userCollection.findOne({
            _id: new ObjectId(req.user.userId),
          });

          if (user.role !== "admin") {
            return res.status(403).json({
              success: false,
              message: "Admin access required",
            });
          }

          const { postId } = req.params;

          if (!ObjectId.isValid(postId)) {
            return res.status(400).json({
              success: false,
              message: "Invalid post ID format",
            });
          }

          const post = await postCollection.findOne({
            _id: new ObjectId(postId),
          });

          if (!post) {
            return res.status(404).json({
              success: false,
              message: "Post not found",
            });
          }

          if (post.status === "published") {
            return res.status(400).json({
              success: false,
              message: "Post is already published",
            });
          }

          // Update post status to published
          await postCollection.updateOne(
            { _id: new ObjectId(postId) },
            {
              $set: {
                status: "published",
                reviewedBy: new ObjectId(req.user.userId),
                reviewedAt: new Date(),
                publishedAt: new Date(),
                updatedAt: new Date(),
              },
            },
          );

          // Update user's blog stats
          await userCollection.updateOne(
            { _id: post.authorId },
            {
              $inc: {
                "blogProfile.totalApprovedPosts": 1,
                "blogProfile.totalPendingPosts": -1,
              },
            },
          );

          // Notify author that post is approved
          await notificationService.sendToUser(post.authorId, {
            type: "blog_post_approved",
            message: `✅ Your post "${post.title}" has been approved and published!`,
            details: "Your post is now visible to all readers.",
            actionUrl: `/posts/${postId}`,
          });

          logger.log(`✅ Post approved: ${postId} by admin ${user.email}`);

          res.json({
            success: true,
            message: "Post approved and published successfully",
          });
        } catch (error) {
          logger.error("Approve post error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to approve post",
          });
        }
      },
    );

    // Reject a post (Admin only)
    api.patch(
      "/admin/posts/:postId/reject",
      authenticateToken,
      async (req, res) => {
        try {
          const user = await userCollection.findOne({
            _id: new ObjectId(req.user.userId),
          });

          if (user.role !== "admin") {
            return res.status(403).json({
              success: false,
              message: "Admin access required",
            });
          }

          const { postId } = req.params;
          const { rejectionReason } = req.body;

          if (!ObjectId.isValid(postId)) {
            return res.status(400).json({
              success: false,
              message: "Invalid post ID format",
            });
          }

          const post = await postCollection.findOne({
            _id: new ObjectId(postId),
          });

          if (!post) {
            return res.status(404).json({
              success: false,
              message: "Post not found",
            });
          }

          await postCollection.updateOne(
            { _id: new ObjectId(postId) },
            {
              $set: {
                status: "rejected",
                reviewedBy: new ObjectId(req.user.userId),
                reviewedAt: new Date(),
                rejectionReason:
                  rejectionReason || "Does not meet our content guidelines",
                updatedAt: new Date(),
              },
            },
          );

          // Update user's blog stats
          await userCollection.updateOne(
            { _id: post.authorId },
            {
              $inc: {
                "blogProfile.totalRejectedPosts": 1,
                "blogProfile.totalPendingPosts": -1,
              },
            },
          );

          // Notify author about rejection
          await notificationService.sendToUser(post.authorId, {
            type: "blog_post_rejected",
            message: `❌ Your post "${post.title}" was not approved`,
            details:
              rejectionReason ||
              "Does not meet our content guidelines. Please review and resubmit.",
            actionUrl: `/my-posts/${postId}/edit`,
          });

          logger.log(`❌ Post rejected: ${postId} by admin ${user.email}`);

          res.json({
            success: true,
            message: "Post rejected successfully",
          });
        } catch (error) {
          logger.error("Reject post error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to reject post",
          });
        }
      },
    );

    // Update post (Author or Admin)
    api.put("/posts/:postId", authenticateToken, async (req, res) => {
      try {
        const { postId } = req.params;
        const { title, content, excerpt, category, coverImage, tags } =
          req.body;
        const userId = req.user.userId;

        if (!ObjectId.isValid(postId)) {
          return res.status(400).json({
            success: false,
            message: "Invalid post ID format",
          });
        }

        const post = await postCollection.findOne({
          _id: new ObjectId(postId),
        });

        if (!post) {
          return res.status(404).json({
            success: false,
            message: "Post not found",
          });
        }

        // Check if user is author or admin
        if (post.authorId.toString() !== userId && req.user.role !== "admin") {
          return res.status(403).json({
            success: false,
            message: "You can only edit your own posts",
          });
        }

        // If post was published, set status back to pending for re-approval
        const newStatus = post.status === "published" ? "pending" : post.status;

        const updateData = {
          ...(title && { title: title.trim() }),
          ...(content && { content }),
          ...(excerpt && { excerpt }),
          ...(category && { category }),
          ...(coverImage !== undefined && { coverImage }),
          ...(tags && { tags }),
          status: newStatus,
          updatedAt: new Date(),
          ...(newStatus === "pending" && {
            reviewedBy: null,
            reviewedAt: null,
            publishedAt: null,
          }),
        };

        const result = await postCollection.updateOne(
          { _id: new ObjectId(postId) },
          { $set: updateData },
        );

        res.json({
          success: true,
          message:
            post.status === "published"
              ? "Post updated and pending re-approval"
              : "Post updated successfully",
        });
      } catch (error) {
        console.error("Update post error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to update post",
        });
      }
    });
    // Delete post (Author or Admin)
    api.delete("/posts/:postId", authenticateToken, async (req, res) => {
      try {
        const { postId } = req.params;
        const userId = req.user.userId;

        if (!ObjectId.isValid(postId)) {
          return res.status(400).json({
            success: false,
            message: "Invalid post ID format",
          });
        }

        const post = await postCollection.findOne({
          _id: new ObjectId(postId),
        });

        if (!post) {
          return res.status(404).json({
            success: false,
            message: "Post not found",
          });
        }

        const user = await userCollection.findOne({
          _id: new ObjectId(userId),
        });

        if (post.authorId.toString() !== userId && user.role !== "admin") {
          return res.status(403).json({
            success: false,
            message: "You can only delete your own posts",
          });
        }

        await postCollection.deleteOne({ _id: new ObjectId(postId) });

        // Update user's blog stats
        const decrementField =
          post.status === "published"
            ? "blogProfile.totalApprovedPosts"
            : post.status === "pending"
              ? "blogProfile.totalPendingPosts"
              : "blogProfile.totalRejectedPosts";

        await userCollection.updateOne(
          { _id: post.authorId },
          {
            $inc: {
              "blogProfile.totalPosts": -1,
              [decrementField]: -1,
            },
          },
        );

        res.json({
          success: true,
          message: "Post deleted successfully",
        });
      } catch (error) {
        logger.error("Delete post error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to delete post",
        });
      }
    });

    // Get posts statistics for admin
    api.get("/admin/posts/stats", authenticateToken, async (req, res) => {
      try {
        // Check if user is admin
        const user = await userCollection.findOne({
          _id: new ObjectId(req.user.userId),
        });

        if (user.role !== "admin") {
          return res.status(403).json({
            success: false,
            message: "Admin access required",
          });
        }

        const total = await postCollection.countDocuments();
        const pending = await postCollection.countDocuments({
          status: "pending",
        });
        const published = await postCollection.countDocuments({
          status: "published",
        });
        const rejected = await postCollection.countDocuments({
          status: "rejected",
        });

        res.json({
          success: true,
          stats: {
            total,
            pending,
            published,
            rejected,
          },
        });
      } catch (error) {
        console.error("Error fetching post stats:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch stats",
        });
      }
    });

    // Check if user liked the post
    api.get("/posts/:id/like-status", authenticateToken, async (req, res) => {
      try {
        const { id } = req.params;
        const userId = req.user.userId;

        const like = await db.collection("likes").findOne({
          postId: id,
          userId: new ObjectId(userId),
        });

        res.json({ liked: !!like });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Like a post
    api.post("/posts/:id/like", authenticateToken, async (req, res) => {
      try {
        const { id } = req.params;
        const userId = req.user.userId;

        await db.collection("likes").insertOne({
          postId: id,
          userId: new ObjectId(userId),
          createdAt: new Date(),
        });

        await db
          .collection("posts")
          .updateOne({ _id: new ObjectId(id) }, { $inc: { likes: 1 } });

        res.json({ success: true, liked: true });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Unlike a post
    api.post("/posts/:id/unlike", authenticateToken, async (req, res) => {
      try {
        const { id } = req.params;
        const userId = req.user.userId;

        await db.collection("likes").deleteOne({
          postId: id,
          userId: new ObjectId(userId),
        });

        await db
          .collection("posts")
          .updateOne({ _id: new ObjectId(id) }, { $inc: { likes: -1 } });

        res.json({ success: true, liked: false });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // ============= ADMIN REVIEW MANAGEMENT =============

    // GET - Get all reviews with filters (Admin only)
    api.get("/admin/reviews", authenticateToken, isAdmin, async (req, res) => {
      try {
        const {
          page = 1,
          limit = 10,
          status = "pending", // pending, approved, rejected
          courseId,
          search,
        } = req.query;

        const skip = (parseInt(page) - 1) * parseInt(limit);
        let query = {};

        // Filter by approval status
        if (status === "pending") {
          query.isApproved = false;
          query.isRejected = { $ne: true };
        } else if (status === "approved") {
          query.isApproved = true;
        } else if (status === "rejected") {
          query.isRejected = true;
        }

        // Filter by course
        if (courseId && ObjectId.isValid(courseId)) {
          query.courseId = new ObjectId(courseId);
        }

        // Search by user name or comment
        if (search) {
          query.$or = [
            { userName: { $regex: search, $options: "i" } },
            { comment: { $regex: search, $options: "i" } },
            { title: { $regex: search, $options: "i" } },
          ];
        }

        const reviews = await reviewCollection
          .find(query)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(parseInt(limit))
          .toArray();

        const total = await reviewCollection.countDocuments(query);

        // Get course details for each review
        const reviewsWithCourse = await Promise.all(
          reviews.map(async (review) => {
            const course = await courseCollection.findOne(
              { _id: review.courseId },
              { projection: { title: 1, thumbnail: 1, slug: 1 } },
            );
            return {
              ...review,
              course,
            };
          }),
        );

        res.json({
          success: true,
          reviews: reviewsWithCourse,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            pages: Math.ceil(total / parseInt(limit)),
          },
        });
      } catch (error) {
        logger.error("Get admin reviews error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch reviews",
        });
      }
    });

    // PATCH - Approve review (Admin/Instructor)
    api.patch(
      "/admin/reviews/:reviewId/approve",
      authenticateToken,
      async (req, res) => {
        try {
          const { reviewId } = req.params;
          const { featured } = req.body;

          // Check if user is admin or instructor
          const user = await userCollection.findOne({
            _id: new ObjectId(req.user.userId),
          });
          if (user.role !== "admin" && user.role !== "instructor") {
            return res.status(403).json({
              success: false,
              message:
                "Unauthorized: Only admins and instructors can approve reviews",
            });
          }

          const updateData = {
            isApproved: true,
            isRejected: false,
            approvedAt: new Date(),
            approvedBy: new ObjectId(req.user.userId),
            ...(featured !== undefined && { isFeatured: featured }),
          };

          const review = await reviewCollection.findOneAndUpdate(
            { _id: new ObjectId(reviewId) },
            { $set: updateData },
            { returnDocument: "after" },
          );

          if (!review) {
            return res.status(404).json({
              success: false,
              message: "Review not found",
            });
          }

          // Update course rating stats
          await updateCourseRatingStats(review.courseId);

          // Send notification to user
          await notificationService.sendToUser(review.userId, {
            type: "review",
            message: "Your review has been approved and is now public!",
            details: `Your review for the course has been approved. Thank you for your feedback!`,
            actionUrl: `/courses/${review.courseId}`,
          });

          res.json({
            success: true,
            message: "Review approved successfully",
            review,
          });
        } catch (error) {
          logger.error("Approve review error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to approve review",
          });
        }
      },
    );

    // PATCH - Reject review (Admin/Instructor)
    api.patch(
      "/admin/reviews/:reviewId/reject",
      authenticateToken,
      async (req, res) => {
        try {
          const { reviewId } = req.params;
          const { reason } = req.body;

          // Check if user is admin or instructor
          const user = await userCollection.findOne({
            _id: new ObjectId(req.user.userId),
          });
          if (user.role !== "admin" && user.role !== "instructor") {
            return res.status(403).json({
              success: false,
              message:
                "Unauthorized: Only admins and instructors can reject reviews",
            });
          }

          const review = await reviewCollection.findOneAndUpdate(
            { _id: new ObjectId(reviewId) },
            {
              $set: {
                isApproved: false,
                isRejected: true,
                rejectedAt: new Date(),
                rejectedBy: new ObjectId(req.user.userId),
                rejectionReason: reason || "Does not meet community guidelines",
              },
            },
            { returnDocument: "after" },
          );

          if (!review) {
            return res.status(404).json({
              success: false,
              message: "Review not found",
            });
          }

          // Send notification to user
          await notificationService.sendToUser(review.userId, {
            type: "review",
            message: "Your review was not approved",
            details:
              reason ||
              "Your review did not meet our community guidelines. Please review and resubmit.",
            actionUrl: `/courses/${review.courseId}`,
          });

          res.json({
            success: true,
            message: "Review rejected successfully",
            review,
          });
        } catch (error) {
          logger.error("Reject review error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to reject review",
          });
        }
      },
    );

    // PATCH - Feature/Unfeature review (Admin only)
    api.patch(
      "/admin/reviews/:reviewId/feature",
      authenticateToken,
      isAdmin,
      async (req, res) => {
        try {
          const { reviewId } = req.params;
          const { featured } = req.body;

          const review = await reviewCollection.findOneAndUpdate(
            { _id: new ObjectId(reviewId) },
            { $set: { isFeatured: featured } },
            { returnDocument: "after" },
          );

          if (!review) {
            return res.status(404).json({
              success: false,
              message: "Review not found",
            });
          }

          res.json({
            success: true,
            message: featured
              ? "Review featured successfully"
              : "Review unfeatured successfully",
            review,
          });
        } catch (error) {
          logger.error("Feature review error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to update review feature status",
          });
        }
      },
    );

    // DELETE - Delete review (Admin only)
    api.delete(
      "/admin/reviews/:reviewId",
      authenticateToken,
      isAdmin,
      async (req, res) => {
        try {
          const { reviewId } = req.params;

          const review = await reviewCollection.findOne({
            _id: new ObjectId(reviewId),
          });

          if (!review) {
            return res.status(404).json({
              success: false,
              message: "Review not found",
            });
          }

          await reviewCollection.deleteOne({ _id: new ObjectId(reviewId) });

          // Update course rating stats
          await updateCourseRatingStats(review.courseId);

          res.json({
            success: true,
            message: "Review deleted successfully",
          });
        } catch (error) {
          logger.error("Delete review error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to delete review",
          });
        }
      },
    );

    // GET - Course Analytics Overview (Instructor/Admin only)
    api.get(
      "/analytics/courses/:courseId",
      authenticateToken,
      async (req, res) => {
        try {
          const { courseId } = req.params;
          const { period = "30d" } = req.query; // 7d, 30d, 90d, 1y, all

          // Check permissions
          const user = await userCollection.findOne({
            _id: new ObjectId(req.user.userId),
          });
          const course = await courseCollection.findOne({
            _id: new ObjectId(courseId),
          });

          if (!course) {
            return res
              .status(404)
              .json({ success: false, message: "Course not found" });
          }

          // Only admin or instructor of this course can view analytics
          if (
            user.role !== "admin" &&
            course.instructor?._id?.toString() !== user._id.toString()
          ) {
            return res.status(403).json({
              success: false,
              message: "Unauthorized to view analytics for this course",
            });
          }

          // Calculate date range
          const endDate = new Date();
          let startDate = new Date();
          if (period === "7d") startDate.setDate(endDate.getDate() - 7);
          else if (period === "30d") startDate.setDate(endDate.getDate() - 30);
          else if (period === "90d") startDate.setDate(endDate.getDate() - 90);
          else if (period === "1y")
            startDate.setFullYear(endDate.getFullYear() - 1);
          else startDate = new Date(0); // All time

          // Get enrollments data
          const enrollments = await userCollection
            .aggregate([
              { $unwind: "$enrolledCourses" },
              {
                $match: { "enrolledCourses.courseId": new ObjectId(courseId) },
              },
              {
                $project: {
                  userId: "$_id",
                  enrollmentDate: "$enrolledCourses.enrollmentDate",
                  status: "$enrolledCourses.status",
                  progress: "$enrolledCourses.progress",
                  completedAt: "$enrolledCourses.completedAt",
                },
              },
            ])
            .toArray();

          // Calculate metrics
          const totalEnrollments = enrollments.length;
          const activeEnrollments = enrollments.filter(
            (e) => e.status === "active",
          ).length;
          const completedEnrollments = enrollments.filter(
            (e) => e.status === "completed",
          ).length;
          const completionRate =
            totalEnrollments > 0
              ? Math.round((completedEnrollments / totalEnrollments) * 100)
              : 0;

          // Calculate average progress
          const avgProgress =
            enrollments.length > 0
              ? Math.round(
                  enrollments.reduce(
                    (sum, e) => sum + (e.progress?.overall || 0),
                    0,
                  ) / enrollments.length,
                )
              : 0;

          // Daily enrollments trend
          const dailyEnrollments = await userCollection
            .aggregate([
              { $unwind: "$enrolledCourses" },
              {
                $match: {
                  "enrolledCourses.courseId": new ObjectId(courseId),
                  "enrolledCourses.enrollmentDate": {
                    $gte: startDate,
                    $lte: endDate,
                  },
                },
              },
              {
                $group: {
                  _id: {
                    $dateToString: {
                      format: "%Y-%m-%d",
                      date: "$enrolledCourses.enrollmentDate",
                    },
                  },
                  count: { $sum: 1 },
                },
              },
              { $sort: { _id: 1 } },
            ])
            .toArray();

          // Get revenue data
          const revenue = await paymentCollection
            .aggregate([
              {
                $match: {
                  courseId: new ObjectId(courseId),
                  status: "COMPLETED",
                  createdAt: { $gte: startDate, $lte: endDate },
                },
              },
              {
                $group: {
                  _id: null,
                  total: { $sum: "$amount" },
                  count: { $sum: 1 },
                  avgPerStudent: { $avg: "$amount" },
                },
              },
            ])
            .toArray();

          const revenueData = revenue[0] || {
            total: 0,
            count: 0,
            avgPerStudent: 0,
          };

          // Get lesson completion data
          const lessonCompletion = await getLessonCompletionStats(courseId);

          // Get rating trends
          const ratingTrends = await reviewCollection
            .aggregate([
              {
                $match: {
                  courseId: new ObjectId(courseId),
                  isApproved: true,
                  createdAt: { $gte: startDate, $lte: endDate },
                },
              },
              {
                $group: {
                  _id: {
                    $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
                  },
                  average: { $avg: "$rating" },
                  count: { $sum: 1 },
                },
              },
              { $sort: { _id: 1 } },
            ])
            .toArray();

          res.json({
            success: true,
            analytics: {
              overview: {
                totalEnrollments,
                activeEnrollments,
                completedEnrollments,
                completionRate,
                avgProgress,
                totalRevenue: revenueData.total,
                revenuePerStudent: revenueData.avgPerStudent,
              },
              trends: {
                enrollments: dailyEnrollments,
                ratings: ratingTrends,
              },
              lessonCompletion,
              revenue: revenueData,
            },
          });
        } catch (error) {
          logger.error("Analytics error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to fetch analytics",
          });
        }
      },
    );

    // GET - Student Progress Analytics (Instructor/Admin only)
    api.get(
      "/analytics/courses/:courseId/students",
      authenticateToken,
      async (req, res) => {
        try {
          const { courseId } = req.params;
          const {
            page = 1,
            limit = 20,
            sortBy = "progress",
            sortOrder = -1,
          } = req.query;

          // Check permissions (similar to above)
          // ... permission check code ...

          const skip = (parseInt(page) - 1) * parseInt(limit);

          const students = await userCollection
            .aggregate([
              { $unwind: "$enrolledCourses" },
              {
                $match: { "enrolledCourses.courseId": new ObjectId(courseId) },
              },
              {
                $project: {
                  _id: 1,
                  name: 1,
                  email: 1,
                  uniqueId: 1,
                  profile: 1,
                  enrollment: "$enrolledCourses",
                  progress: "$enrolledCourses.progress.overall",
                  lastAccessed: "$enrolledCourses.progress.lastAccessed",
                  timeSpent: "$enrolledCourses.progress.timeSpent",
                  completedTopics: {
                    $size: {
                      $ifNull: [
                        "$enrolledCourses.progress.completedTopics",
                        [],
                      ],
                    },
                  },
                  totalTopics: course.stats?.totalTopics || 0,
                },
              },
              { $sort: { [sortBy]: parseInt(sortOrder) } },
              { $skip: skip },
              { $limit: parseInt(limit) },
            ])
            .toArray();

          const total = await userCollection.countDocuments({
            "enrolledCourses.courseId": new ObjectId(courseId),
          });

          // Calculate completion percentage for each student
          const studentsWithStats = students.map((s) => ({
            ...s,
            completionPercentage:
              s.totalTopics > 0
                ? Math.round((s.completedTopics / s.totalTopics) * 100)
                : 0,
          }));

          res.json({
            success: true,
            students: studentsWithStats,
            pagination: {
              page: parseInt(page),
              limit: parseInt(limit),
              total,
              pages: Math.ceil(total / parseInt(limit)),
            },
          });
        } catch (error) {
          logger.error("Student analytics error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to fetch student analytics",
          });
        }
      },
    );

    // GET - Instructor Dashboard Analytics (Admin/Instructor)
    api.get("/analytics/dashboard", authenticateToken, async (req, res) => {
      try {
        const userId = req.user.userId;
        const user = await userCollection.findOne({
          _id: new ObjectId(userId),
        });

        let query = {};
        if (user.role !== "admin") {
          // Instructors see only their courses
          query = { "instructor._id": new ObjectId(userId) };
        }

        // Get all courses for this user
        const courses = await courseCollection.find(query).toArray();
        const courseIds = courses.map((c) => c._id);

        // Overall stats
        const totalCourses = courses.length;

        // Total enrollments across all courses
        const enrollments = await userCollection
          .aggregate([
            { $unwind: "$enrolledCourses" },
            { $match: { "enrolledCourses.courseId": { $in: courseIds } } },
            { $count: "total" },
          ])
          .toArray();
        const totalEnrollments = enrollments[0]?.total || 0;

        // Total revenue
        const revenue = await paymentCollection
          .aggregate([
            { $match: { courseId: { $in: courseIds }, status: "COMPLETED" } },
            { $group: { _id: null, total: { $sum: "$amount" } } },
          ])
          .toArray();
        const totalRevenue = revenue[0]?.total || 0;

        // Average completion rate
        const completionData = await userCollection
          .aggregate([
            { $unwind: "$enrolledCourses" },
            { $match: { "enrolledCourses.courseId": { $in: courseIds } } },
            {
              $group: {
                _id: null,
                avgProgress: { $avg: "$enrolledCourses.progress.overall" },
                totalCompleted: {
                  $sum: {
                    $cond: [
                      { $eq: ["$enrolledCourses.status", "completed"] },
                      1,
                      0,
                    ],
                  },
                },
              },
            },
          ])
          .toArray();

        // Course-wise breakdown
        const courseStats = await Promise.all(
          courses.map(async (course) => {
            const courseEnrollments = await userCollection.countDocuments({
              "enrolledCourses.courseId": course._id,
            });

            const courseRevenue = await paymentCollection
              .aggregate([
                { $match: { courseId: course._id, status: "COMPLETED" } },
                { $group: { _id: null, total: { $sum: "$amount" } } },
              ])
              .toArray();

            return {
              _id: course._id,
              title: course.title,
              slug: course.slug,
              thumbnail: course.thumbnail,
              enrollments: courseEnrollments,
              revenue: courseRevenue[0]?.total || 0,
              rating: course.stats?.averageRating || 0,
              reviews: course.stats?.totalReviews || 0,
            };
          }),
        );

        res.json({
          success: true,
          analytics: {
            overview: {
              totalCourses,
              totalEnrollments,
              totalRevenue,
              averageProgress: completionData[0]?.avgProgress || 0,
              totalCompleted: completionData[0]?.totalCompleted || 0,
            },
            courseStats,
          },
        });
      } catch (error) {
        logger.error("Dashboard analytics error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch dashboard analytics",
        });
      }
    });

    // Helper function to get lesson completion stats
    async function getLessonCompletionStats(courseId) {
      const chapters = await chapterCollection
        .find({ courseId: new ObjectId(courseId) })
        .toArray();
      const chapterIds = chapters.map((c) => c._id);
      const lessons = await lessonCollection
        .find({ chapterId: { $in: chapterIds } })
        .toArray();

      const stats = [];
      for (const lesson of lessons) {
        const completions = await userCollection.countDocuments({
          "enrolledCourses.courseId": new ObjectId(courseId),
          "enrolledCourses.progress.completedLessons": lesson._id,
        });

        stats.push({
          lessonId: lesson._id,
          title: lesson.title,
          completions,
        });
      }

      return stats;
    }

    // Health check endpoint
    api.get("/health", (req, res) => {
      res.status(200).json({
        success: true,
        message: "Server is running",
        database: "connected",
        uptime: process.uptime(),
        timestamp: new Date(),
      });
    });

    // 404 handler for undefined routes
    api.use((req, res) => {
      res.status(404).json({
        success: false,
        message: `Route ${req.method} ${req.path} not found`,
      });
    });

    // Global error handler
    api.use((err, req, res, next) => {
      logger.error("Global error:", err);
      res.status(500).json({
        success: false,
        message: "Internal server error",
        error: err.message,
      });
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    logger.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } catch (error) {
    logger.error("Failed to connect to MongoDB:", error);
    process.exit(1);
  }
}

// Run the application
// run().catch(console.dir);

app.use("/api", api);

// Global Error Handler
app.use((err, req, res, next) => {
  logger.error("❌ Global Error:", err);

  res.status(err.status || 500).json({
    success: false,
    message:
      process.env.NODE_ENV === "production"
        ? "Internal server error"
        : err.message,
  });
});

let server;

run()
  .then(() => {
    server = app.listen(PORT, "0.0.0.0", () => {
      logger.log(`✅ Server running on port ${PORT}`);
    });
  })
  .catch((error) => {
    logger.error("❌ Failed to start server:", error);
  });

// Graceful shutdown
process.on("SIGINT", async () => {
  logger.log("🛑 Shutting down gracefully...");

  if (server) {
    server.close();
  }

  await client.close();

  logger.log("✅ MongoDB connection closed");

  process.exit(0);
});
