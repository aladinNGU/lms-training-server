// backend/index.js
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const { MongoClient, ObjectId, ServerApiVersion } = require("mongodb");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 7000;

// Middleware
app.use(cors());
app.use(express.json());

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

// MongoDB Connection
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.zn6isea.mongodb.net/?appName=Cluster0`;

// Create a MongoClient
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server
    await client.connect();
    console.log("Connected to MongoDB");

    const db = client.db("lmsDB");
    const courseCollection = db.collection("courses");
    const chapterCollection = db.collection("chapters");
    const lessonCollection = db.collection("lessons");
    const topicCollection = db.collection("topics");
    const userCollection = db.collection("users");
    const otpCollection = db.collection("otp");
    const certificateCollection = db.collection("certificates");

    // Create indexes for better performance
    await courseCollection.createIndex({ slug: 1 }, { unique: true });
    await courseCollection.createIndex({ status: 1 });
    await courseCollection.createIndex({ level: 1 });
    await courseCollection.createIndex({ createdAt: -1 });
    await chapterCollection.createIndex({ courseId: 1, order: 1 });
    await lessonCollection.createIndex({ chapterId: 1, order: 1 });
    await topicCollection.createIndex({ lessonId: 1, order: 1 });

    console.log("Database indexes created");

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

    // Helper function to handle course completion
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
        instructorName: "Dr. Smith",
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

      // Send notification
      await userCollection.updateOne(
        { _id: new ObjectId(userId) },
        {
          $push: {
            notifications: {
              type: "course",
              message: `Congratulations! You've completed ${course.title}`,
              read: false,
              createdAt: new Date(),
            },
          },
        },
      );

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

    // ============= AUTH ROUTES =============

    // Register new user
    app.post("/auth/register", async (req, res) => {
      try {
        const { name, email, password, role = "student" } = req.body;

        // Check if user exists
        const existingUser = await userCollection.findOne({ email });
        if (existingUser) {
          return res
            .status(400)
            .json({ success: false, message: "Email already exists" });
        }

        // ===== ADD PASSWORD STRENGTH VALIDATION =====
        if (password.length < 6) {
          return res.status(400).json({
            success: false,
            message: "Password must be at least 6 characters long",
          });
        }

        // Optional: Add more complex password requirements
        if (!/[A-Z]/.test(password)) {
          return res.status(400).json({
            success: false,
            message: "Password must contain at least one uppercase letter",
          });
        }

        if (!/[0-9]/.test(password)) {
          return res.status(400).json({
            success: false,
            message: "Password must contain at least one number",
          });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Generate unique ID
        const uniqueId = await generateUniqueStudentId();

        const userData = {
          uniqueId,
          name,
          email,
          password: hashedPassword,
          role,
          profile: {
            photo: "",
            phone: "",
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
            bio: "",
            socialLinks: {
              github: "",
              linkedin: "",
              twitter: "",
            },
          },
          enrolledCourses: [],
          wishlist: [],
          notifications: [],
          settings: {
            emailNotifications: true,
            twoFactorAuth: false,
            language: "en",
          },
          createdAt: new Date(),
          updatedAt: new Date(),
          lastLogin: new Date(),
        };

        const result = await userCollection.insertOne(userData);

        // Create JWT token
        const token = jwt.sign(
          { userId: result.insertedId, email, role },
          process.env.JWT_SECRET,
          { expiresIn: "7d" },
        );

        res.status(201).json({
          success: true,
          message: "User registered successfully",
          token,
          user: { ...userData, _id: result.insertedId, password: undefined },
        });
      } catch (error) {
        console.error("Register error:", error);
        res.status(500).json({
          success: false,
          message: "Registration failed",
          error: error.message,
        });
      }
    });

    // Login
    app.post("/auth/login", async (req, res) => {
      try {
        const { email, password } = req.body;

        const user = await userCollection.findOne({ email });
        if (!user) {
          return res
            .status(401)
            .json({ success: false, message: "Invalid credentials" });
        }

        const isValidPassword = await bcrypt.compare(password, user.password);
        if (!isValidPassword) {
          return res
            .status(401)
            .json({ success: false, message: "Invalid credentials" });
        }

        // Update last login
        await userCollection.updateOne(
          { _id: user._id },
          { $set: { lastLogin: new Date() } },
        );

        const token = jwt.sign(
          { userId: user._id, email: user.email, role: user.role },
          process.env.JWT_SECRET,
          { expiresIn: "7d" },
        );

        res.json({
          success: true,
          message: "Login successful",
          token,
          user: { ...user, password: undefined },
        });
      } catch (error) {
        console.error("Login error:", error);
        res.status(500).json({
          success: false,
          message: "Login failed",
          error: error.message,
        });
      }
    });

    // ============= PASSWORD RESET WITH OTP =============

    // Request OTP for password reset
    app.post("/auth/forgot-password", async (req, res) => {
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
          subject: "Password Reset OTP - LMS Academy",
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
          <p style="color: #6b7280; font-size: 12px;">LMS Academy - Your Learning Partner</p>
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
        console.error("Forgot password error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to send OTP",
          error: error.message,
        });
      }
    });

    // Verify OTP
    app.post("/auth/verify-otp", async (req, res) => {
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
        console.error("Verify OTP error:", error);
        res.status(500).json({
          success: false,
          message: "OTP verification failed",
          error: error.message,
        });
      }
    });

    // Reset password
    app.post("/auth/reset-password", async (req, res) => {
      try {
        const { token, newPassword } = req.body;

        // Verify token
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (!decoded || decoded.purpose !== "password_reset") {
          return res
            .status(401)
            .json({ success: false, message: "Invalid or expired token" });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);

        await userCollection.updateOne(
          { email: decoded.email },
          { $set: { password: hashedPassword, updatedAt: new Date() } },
        );

        // Clear used OTPs
        await otpCollection.deleteMany({
          email: decoded.email,
          purpose: "password_reset",
        });

        res.json({
          success: true,
          message: "Password reset successfully",
        });
      } catch (error) {
        console.error("Reset password error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to reset password",
          error: error.message,
        });
      }
    });

    // ============= USER PROFILE ROUTES =============

    // Get user profile
    app.get("/users/profile", authenticateToken, async (req, res) => {
      try {
        const user = await userCollection.findOne(
          { _id: new ObjectId(req.user.userId) },
          { projection: { password: 0 } },
        );

        if (!user) {
          return res
            .status(404)
            .json({ success: false, message: "User not found" });
        }

        res.json({ success: true, user });
      } catch (error) {
        console.error("Get profile error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch profile",
          error: error.message,
        });
      }
    });

    // Update user profile
    app.put("/users/profile", authenticateToken, async (req, res) => {
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
        console.error("Update profile error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to update profile",
          error: error.message,
        });
      }
    });

    // ============= COURSE ENROLLMENT ROUTES =============

    // Enroll in a course
    app.post("/users/enroll/:courseId", authenticateToken, async (req, res) => {
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

        // Get course structure for progress tracking
        const chapters = await chapterCollection
          .find({ courseId: new ObjectId(courseId) })
          .toArray();

        const lessons = await lessonCollection
          .find({ chapterId: { $in: chapters.map((c) => c._id) } })
          .toArray();

        const topics = await topicCollection
          .find({ lessonId: { $in: lessons.map((l) => l._id) } })
          .toArray();

        const enrollmentData = {
          courseId: new ObjectId(courseId),
          enrollmentDate: new Date(),
          startDate: new Date(),
          endDate: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90 days from now
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

        await userCollection.updateOne(
          { _id: new ObjectId(userId) },
          { $push: { enrolledCourses: enrollmentData } },
        );

        res.json({
          success: true,
          message: "Successfully enrolled in course",
          enrollment: enrollmentData,
        });
      } catch (error) {
        console.error("Enrollment error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to enroll",
          error: error.message,
        });
      }
    });

    // Update course progress
    app.post(
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
          console.error("Progress update error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to update progress",
            error: error.message,
          });
        }
      },
    );

    // Get user's enrolled courses with progress
    app.get("/users/my-courses", authenticateToken, async (req, res) => {
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
                },
              },
            );
            return {
              ...course,
              enrollment: enrollment,
            };
          }),
        );

        res.json({
          success: true,
          courses: coursesWithProgress,
        });
      } catch (error) {
        console.error("Get my courses error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch courses",
          error: error.message,
        });
      }
    });

    // Get user's certificates
    app.get("/users/certificates", authenticateToken, async (req, res) => {
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
        console.error("Get certificates error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch certificates",
          error: error.message,
        });
      }
    });

    // Verify certificate
    app.get("/certificates/verify/:certificateId", async (req, res) => {
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
        console.error("Verify certificate error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to verify certificate",
          error: error.message,
        });
      }
    });

    // Add to wishlist
    app.post(
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
          console.error("Wishlist error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to add to wishlist",
            error: error.message,
          });
        }
      },
    );

    // Remove from wishlist
    app.delete(
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
          console.error("Remove wishlist error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to remove from wishlist",
            error: error.message,
          });
        }
      },
    );

    // Get wishlist
    app.get("/users/wishlist", authenticateToken, async (req, res) => {
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
        console.error("Get wishlist error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch wishlist",
          error: error.message,
        });
      }
    });

    // Get user notifications
    app.get("/users/notifications", authenticateToken, async (req, res) => {
      try {
        const user = await userCollection.findOne(
          { _id: new ObjectId(req.user.userId) },
          { projection: { notifications: 1 } },
        );

        res.json({
          success: true,
          notifications: user.notifications || [],
        });
      } catch (error) {
        console.error("Get notifications error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch notifications",
          error: error.message,
        });
      }
    });

    // Mark notification as read
    app.put(
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
          console.error("Mark notification error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to mark notification",
            error: error.message,
          });
        }
      },
    );

    // Update user settings
    app.put("/users/settings", authenticateToken, async (req, res) => {
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
        console.error("Update settings error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to update settings",
          error: error.message,
        });
      }
    });

    // ============= COURSE ROUTES =============

    app.get("/", (req, res) => {
      res.send(`LMS Training server is running on port ${PORT}`);
    });

    // GET all courses
    app.get("/courses", async (req, res) => {
      try {
        const courses = await courseCollection
          .find({ status: "published" })
          .sort({ createdAt: -1 })
          .toArray();

        res.status(200).json({
          success: true,
          count: courses.length,
          courses,
        });
      } catch (error) {
        console.error("Get courses error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch courses",
          error: error.message,
        });
      }
    });

    // GET single course by slug
    app.get("/courses/:slug", async (req, res) => {
      try {
        const course = await courseCollection.findOne({
          slug: req.params.slug,
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
        console.error("Get course error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch course",
          error: error.message,
        });
      }
    });

    // GET single course by ID (NEW ROUTE)
    app.get("/courses/id/:id", async (req, res) => {
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
        console.error("Get course by ID error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch course",
          error: error.message,
        });
      }
    });

    // POST create new course
    app.post("/courses", async (req, res) => {
      try {
        const { title, description, price, level, duration, thumbnail } =
          req.body;

        // Validate required fields
        if (!title || !description || !price) {
          return res.status(400).json({
            success: false,
            message: "Title, description and price are required",
          });
        }

        // Generate unique slug
        const slug = await createUniqueSlug(title, courseCollection);

        const courseData = {
          title,
          slug,
          description,
          price: parseFloat(price),
          level: level || "beginner",
          duration: duration || "12 weeks",
          thumbnail: thumbnail || "https://via.placeholder.com/300x200",
          totalChapters: 0,
          totalLessons: 0,
          totalTopics: 0,
          status: "published",
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const result = await courseCollection.insertOne(courseData);

        res.status(201).json({
          success: true,
          message: "Course created successfully",
          course: { ...courseData, _id: result.insertedId },
        });
      } catch (error) {
        console.error("Create course error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to create course",
          error: error.message,
        });
      }
    });

    // PUT update course
    app.put("/courses/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const {
          title,
          description,
          price,
          level,
          duration,
          thumbnail,
          status,
        } = req.body;

        // Validate ID
        if (!ObjectId.isValid(id)) {
          return res.status(400).json({
            success: false,
            message: "Invalid course ID format",
          });
        }

        const updateData = {
          ...(title && { title }),
          ...(description && { description }),
          ...(price && { price: parseFloat(price) }),
          ...(level && { level }),
          ...(duration && { duration }),
          ...(thumbnail && { thumbnail }),
          ...(status && { status }),
          updatedAt: new Date(),
        };

        // If title is updated, update slug as well
        if (title) {
          updateData.slug = await createUniqueSlug(title, courseCollection);
        }

        const result = await courseCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updateData },
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({
            success: false,
            message: "Course not found",
          });
        }

        res.status(200).json({
          success: true,
          message: "Course updated successfully",
        });
      } catch (error) {
        console.error("Update course error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to update course",
          error: error.message,
        });
      }
    });

    // DELETE course
    app.delete("/courses/:id", async (req, res) => {
      try {
        const { id } = req.params;

        // Validate ID
        if (!ObjectId.isValid(id)) {
          return res.status(400).json({
            success: false,
            message: "Invalid course ID format",
          });
        }

        const result = await courseCollection.deleteOne({
          _id: new ObjectId(id),
        });

        if (result.deletedCount === 0) {
          return res.status(404).json({
            success: false,
            message: "Course not found",
          });
        }

        res.status(200).json({
          success: true,
          message: "Course deleted successfully",
        });
      } catch (error) {
        console.error("Delete course error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to delete course",
          error: error.message,
        });
      }
    });

    // ============= CHAPTER ROUTES =============
    // GET chapters by course ID (using course _id)
    app.get("/courses/:courseId/chapters", async (req, res) => {
      try {
        const { courseId } = req.params;
        console.log("Fetching chapters for course identifier:", courseId);

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

        console.log("Found course:", course.title, "with _id:", course._id);

        // Find chapters using the course's _id
        const chapters = await db
          .collection("chapters")
          .find({ courseId: course._id })
          .sort({ order: 1 })
          .toArray();

        console.log(`Found ${chapters.length} chapters`);
        res.json({ success: true, chapters });
      } catch (error) {
        console.error("Get chapters error:", error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // ============= NEW CHAPTER ROUTES =============
    // GET single chapter by ID
    app.get("/chapters/:chapterId", async (req, res) => {
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
        console.error("Get chapter error:", error);
        res.status(500).json({
          success: false,
          error: error.message,
        });
      }
    });

    // POST create new chapter
    app.post("/chapters", async (req, res) => {
      try {
        const { courseId, title, description, order } = req.body;

        // Validate required fields
        if (!courseId || !title) {
          return res.status(400).json({
            success: false,
            message: "Course ID and title are required",
          });
        }

        // Verify course exists
        let courseQuery;
        if (ObjectId.isValid(courseId)) {
          courseQuery = { _id: new ObjectId(courseId) };
        } else {
          courseQuery = { _id: courseId };
        }

        const course = await db.collection("courses").findOne(courseQuery);
        if (!course) {
          return res.status(404).json({
            success: false,
            message: "Course not found",
          });
        }

        // Get the highest order number for this course
        const lastChapter = await db
          .collection("chapters")
          .find({ courseId: course._id })
          .sort({ order: -1 })
          .limit(1)
          .toArray();

        const nextOrder = lastChapter.length > 0 ? lastChapter[0].order + 1 : 1;

        const chapterData = {
          courseId: course._id,
          title,
          description: description || "",
          order: order || nextOrder,
          totalLessons: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const result = await db.collection("chapters").insertOne(chapterData);

        // Update course's totalChapters count
        await db
          .collection("courses")
          .updateOne({ _id: course._id }, { $inc: { totalChapters: 1 } });

        res.status(201).json({
          success: true,
          message: "Chapter created successfully",
          chapter: { ...chapterData, _id: result.insertedId },
        });
      } catch (error) {
        console.error("Create chapter error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to create chapter",
          error: error.message,
        });
      }
    });

    // PUT update chapter
    app.put("/chapters/:chapterId", async (req, res) => {
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
        console.error("Update chapter error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to update chapter",
          error: error.message,
        });
      }
    });

    // DELETE chapter
    app.delete("/chapters/:chapterId", async (req, res) => {
      try {
        const { chapterId } = req.params;

        // Validate ID
        if (!ObjectId.isValid(chapterId)) {
          return res.status(400).json({
            success: false,
            message: "Invalid chapter ID format",
          });
        }

        // Get chapter to find courseId
        const chapter = await db.collection("chapters").findOne({
          _id: new ObjectId(chapterId),
        });

        if (!chapter) {
          return res.status(404).json({
            success: false,
            message: "Chapter not found",
          });
        }

        // Delete all lessons and topics in this chapter first
        const lessons = await db
          .collection("lessons")
          .find({ chapterId: chapter._id })
          .toArray();

        for (const lesson of lessons) {
          await db.collection("topics").deleteMany({ lessonId: lesson._id });
        }

        await db.collection("lessons").deleteMany({ chapterId: chapter._id });

        // Delete the chapter
        const result = await db.collection("chapters").deleteOne({
          _id: new ObjectId(chapterId),
        });

        // Update course's totalChapters count
        await db
          .collection("courses")
          .updateOne(
            { _id: chapter.courseId },
            { $inc: { totalChapters: -1 } },
          );

        res.json({
          success: true,
          message: "Chapter and all its contents deleted successfully",
        });
      } catch (error) {
        console.error("Delete chapter error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to delete chapter",
          error: error.message,
        });
      }
    });

    // POST reorder chapters
    app.post("/chapters/reorder", async (req, res) => {
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
        console.error("Reorder chapters error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to reorder chapters",
          error: error.message,
        });
      }
    });

    // ============= LESSON ROUTES =============
    // GET lessons by chapter ID
    app.get("/chapters/:chapterId/lessons", async (req, res) => {
      try {
        const { chapterId } = req.params;
        console.log("Fetching lessons for chapter:", chapterId);

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

        console.log(`Found ${lessons.length} lessons`);
        res.json({ success: true, lessons });
      } catch (error) {
        console.error("Get lessons error:", error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // GET single lesson with its topics
    app.get("/lessons/:lessonId", async (req, res) => {
      try {
        const { lessonId } = req.params;
        console.log("Fetching lesson with topics:", lessonId);

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

        console.log(`Found ${topics.length} topics for lesson`);
        res.json({ success: true, lesson, topics });
      } catch (error) {
        console.error("Get lesson error:", error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // POST create new lesson
    app.post("/lessons", async (req, res) => {
      try {
        const { chapterId, title, description, order } = req.body;

        // Validate required fields
        if (!chapterId || !title) {
          return res.status(400).json({
            success: false,
            message: "Chapter ID and title are required",
          });
        }

        // Verify chapter exists
        let chapterQuery;
        if (ObjectId.isValid(chapterId)) {
          chapterQuery = { _id: new ObjectId(chapterId) };
        } else {
          chapterQuery = { _id: chapterId };
        }

        const chapter = await db.collection("chapters").findOne(chapterQuery);
        if (!chapter) {
          return res.status(404).json({
            success: false,
            message: "Chapter not found",
          });
        }

        // Get the highest order number for this chapter
        const lastLesson = await db
          .collection("lessons")
          .find({ chapterId: chapter._id })
          .sort({ order: -1 })
          .limit(1)
          .toArray();

        const nextOrder = lastLesson.length > 0 ? lastLesson[0].order + 1 : 1;

        const lessonData = {
          chapterId: chapter._id,
          title,
          description: description || "",
          order: order || nextOrder,
          totalTopics: 0,
          completed: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const result = await db.collection("lessons").insertOne(lessonData);

        // Update chapter's totalLessons count
        await db
          .collection("chapters")
          .updateOne({ _id: chapter._id }, { $inc: { totalLessons: 1 } });

        // Update course's totalLessons count
        await db
          .collection("courses")
          .updateOne({ _id: chapter.courseId }, { $inc: { totalLessons: 1 } });

        res.status(201).json({
          success: true,
          message: "Lesson created successfully",
          lesson: { ...lessonData, _id: result.insertedId },
        });
      } catch (error) {
        console.error("Create lesson error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to create lesson",
          error: error.message,
        });
      }
    });

    // PUT update lesson
    app.put("/lessons/:lessonId", async (req, res) => {
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
        console.error("Update lesson error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to update lesson",
          error: error.message,
        });
      }
    });

    // DELETE lesson
    app.delete("/lessons/:lessonId", async (req, res) => {
      try {
        const { lessonId } = req.params;

        // Validate ID
        if (!ObjectId.isValid(lessonId)) {
          return res.status(400).json({
            success: false,
            message: "Invalid lesson ID format",
          });
        }

        // Get lesson to find chapterId
        const lesson = await db.collection("lessons").findOne({
          _id: new ObjectId(lessonId),
        });

        if (!lesson) {
          return res.status(404).json({
            success: false,
            message: "Lesson not found",
          });
        }

        // Get chapter to find courseId
        const chapter = await db.collection("chapters").findOne({
          _id: lesson.chapterId,
        });

        // Delete all topics in this lesson
        await db.collection("topics").deleteMany({ lessonId: lesson._id });

        // Delete the lesson
        const result = await db.collection("lessons").deleteOne({
          _id: new ObjectId(lessonId),
        });

        // Update chapter's totalLessons count
        await db
          .collection("chapters")
          .updateOne({ _id: lesson.chapterId }, { $inc: { totalLessons: -1 } });

        // Update course's totalLessons count
        if (chapter) {
          await db
            .collection("courses")
            .updateOne(
              { _id: chapter.courseId },
              { $inc: { totalLessons: -1 } },
            );
        }

        res.json({
          success: true,
          message: "Lesson and all its topics deleted successfully",
        });
      } catch (error) {
        console.error("Delete lesson error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to delete lesson",
          error: error.message,
        });
      }
    });

    // POST reorder lessons
    app.post("/lessons/reorder", async (req, res) => {
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
        console.error("Reorder lessons error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to reorder lessons",
          error: error.message,
        });
      }
    });
    // ============= TOPIC ROUTES =============

    // GET all topics for a lesson
    app.get("/lessons/:lessonId/topics", async (req, res) => {
      try {
        const { lessonId } = req.params;
        console.log("Fetching topics for lesson:", lessonId);

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

        console.log(`Found ${topics.length} topics`);
        res.json({ success: true, topics });
      } catch (error) {
        console.error("Get topics error:", error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // GET single topic by ID
    app.get("/topics/:topicId", async (req, res) => {
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
        console.error("Get topic error:", error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // POST create new topic
    app.post("/topics", async (req, res) => {
      try {
        const { lessonId, title, content, order } = req.body;

        // Validate required fields
        if (!lessonId || !title) {
          return res.status(400).json({
            success: false,
            message: "Lesson ID and title are required",
          });
        }

        // Verify lesson exists
        if (!ObjectId.isValid(lessonId)) {
          return res
            .status(400)
            .json({ success: false, message: "Invalid lesson ID format" });
        }

        const lesson = await db.collection("lessons").findOne({
          _id: new ObjectId(lessonId),
        });

        if (!lesson) {
          return res
            .status(404)
            .json({ success: false, message: "Lesson not found" });
        }

        // Get the highest order number for this lesson
        const lastTopic = await db
          .collection("topics")
          .find({ lessonId: new ObjectId(lessonId) })
          .sort({ order: -1 })
          .limit(1)
          .toArray();

        const nextOrder = lastTopic.length > 0 ? lastTopic[0].order + 1 : 1;

        const topicData = {
          lessonId: new ObjectId(lessonId),
          title,
          content: content || {
            description: "",
            contentBlocks: [],
            duration: "",
            readingTime: "",
          },
          order: order || nextOrder,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const result = await db.collection("topics").insertOne(topicData);

        // Update lesson's totalTopics count
        await db
          .collection("lessons")
          .updateOne(
            { _id: new ObjectId(lessonId) },
            { $inc: { totalTopics: 1 } },
          );

        res.status(201).json({
          success: true,
          message: "Topic created successfully",
          topic: { ...topicData, _id: result.insertedId },
        });
      } catch (error) {
        console.error("Create topic error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to create topic",
          error: error.message,
        });
      }
    });

    // PUT update topic
    app.put("/topics/:topicId", async (req, res) => {
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
        console.error("Update topic error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to update topic",
          error: error.message,
        });
      }
    });

    // DELETE topic
    app.delete("/topics/:topicId", async (req, res) => {
      try {
        const { topicId } = req.params;

        // Validate ID
        if (!ObjectId.isValid(topicId)) {
          return res
            .status(400)
            .json({ success: false, message: "Invalid topic ID format" });
        }

        // Get topic to find lessonId
        const topic = await db.collection("topics").findOne({
          _id: new ObjectId(topicId),
        });

        if (!topic) {
          return res
            .status(404)
            .json({ success: false, message: "Topic not found" });
        }

        // Delete the topic
        const result = await db.collection("topics").deleteOne({
          _id: new ObjectId(topicId),
        });

        // Update lesson's totalTopics count
        await db
          .collection("lessons")
          .updateOne({ _id: topic.lessonId }, { $inc: { totalTopics: -1 } });

        res.json({
          success: true,
          message: "Topic deleted successfully",
        });
      } catch (error) {
        console.error("Delete topic error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to delete topic",
          error: error.message,
        });
      }
    });

    // POST reorder topics
    app.post("/topics/reorder", async (req, res) => {
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
        console.error("Reorder topics error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to reorder topics",
          error: error.message,
        });
      }
    });

    // ============= ADD THIS ROUTE =============
    // Change password (requires authentication)
    app.post("/auth/change-password", authenticateToken, async (req, res) => {
      try {
        const { currentPassword, newPassword } = req.body;
        const userId = req.user.userId;

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
        console.error("Change password error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to change password",
          error: error.message,
        });
      }
    });

    // Add this route
    app.delete(
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
          console.error("Delete notification error:", error);
          res
            .status(500)
            .json({ success: false, message: "Failed to delete notification" });
        }
      },
    );
    // Add this route
    app.delete("/users/notifications", authenticateToken, async (req, res) => {
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
        console.error("Clear notifications error:", error);
        res
          .status(500)
          .json({ success: false, message: "Failed to clear notifications" });
      }
    });
    // Health check endpoint
    app.get("/health", (req, res) => {
      res.status(200).json({
        success: true,
        message: "Server is running",
        database: "connected",
        timestamp: new Date(),
      });
    });

    // 404 handler for undefined routes
    app.use((req, res) => {
      res.status(404).json({
        success: false,
        message: `Route ${req.method} ${req.path} not found`,
      });
    });

    // Global error handler
    app.use((err, req, res, next) => {
      console.error("Global error:", err);
      res.status(500).json({
        success: false,
        message: "Internal server error",
        error: err.message,
      });
    });

    // START SERVER HERE - AFTER all routes are defined
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } catch (error) {
    console.error("Failed to connect to MongoDB:", error);
    process.exit(1);
  }
}

// Run the application
run().catch(console.dir);

// Handle graceful shutdown
process.on("SIGINT", async () => {
  console.log("Closing MongoDB connection...");
  await client.close();
  console.log("MongoDB connection closed");
  process.exit(0);
});
