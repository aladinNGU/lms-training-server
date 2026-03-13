// backend/index.js
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const axios = require("axios");
const crypto = require("crypto");
const { MongoClient, ObjectId, ServerApiVersion } = require("mongodb");
require("dotenv").config();
const PDFDocument = require("pdfkit");

const app = express();
const PORT = process.env.PORT || 7000;

// Middleware
app.use(cors());
app.use(express.json());

// bKash Configuration
const BKASH_CONFIG = {
  app_key: process.env.BKASH_APP_KEY,
  app_secret: process.env.BKASH_APP_SECRET,
  username: process.env.BKASH_USERNAME,
  password: process.env.BKASH_PASSWORD,
  base_url: process.env.BKASH_BASE_URL,
  frontend_url: process.env.BKASH_FRONTEND_URL,
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
    // ===== EMAIL CONFIGURATION VALIDATION =====
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      console.warn(
        "⚠️ Email credentials not configured. OTP emails will not be sent.",
      );
      console.warn("Please set EMAIL_USER and EMAIL_PASS in your .env file");
    } else {
      try {
        const testTransporter = nodemailer.createTransport({
          service: "gmail",
          auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
          },
        });
        await testTransporter.verify();
        console.log("✅ Email configuration verified");
      } catch (emailError) {
        console.warn("⚠️ Email configuration invalid:", emailError.message);
      }
    }

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
    const paymentCollection = db.collection("payments");
    const emailLogCollection = db.collection("emailLogs");
    const testimonialCollection = db.collection("testimonials");

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

    console.log("Database indexes created");

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
    console.log("Payment indexes created");

    // Create indexes for email logs collection
    await emailLogCollection.createIndex({ userId: 1 });
    await emailLogCollection.createIndex({ merchantInvoiceNumber: 1 });
    await emailLogCollection.createIndex({ sentAt: -1 });
    console.log("✅ Email logs indexes created");

    // Create indexes for testimonials
    await testimonialCollection.createIndex({ status: 1, isApproved: 1 });
    await testimonialCollection.createIndex({ createdAt: -1 });

    // Middleware to check if user is admin
    // ============= FIXED isAdmin MIDDLEWARE =============
    // ============= IMPROVED isAdmin MIDDLEWARE =============
    async function isAdmin(req, res, next) {
      try {
        // Check if req.user exists
        if (!req.user) {
          console.error("❌ isAdmin: No user object in request");
          return res.status(401).json({
            success: false,
            message: "Authentication required",
          });
        }

        const userId = req.user.userId;

        console.log("🔍 isAdmin checking userId:", userId);

        // Validate userId exists
        if (!userId) {
          console.error("❌ isAdmin: No userId in token");
          return res.status(400).json({
            success: false,
            message: "Invalid token: No user ID",
          });
        }

        // Validate userId format
        if (!ObjectId.isValid(userId)) {
          console.error("❌ isAdmin: Invalid userId format:", userId);
          return res.status(400).json({
            success: false,
            message: "Invalid user ID format in token",
          });
        }

        const user = await userCollection.findOne({
          _id: new ObjectId(userId),
        });

        if (!user) {
          console.error("❌ isAdmin: User not found for ID:", userId);
          return res.status(404).json({
            success: false,
            message: "User not found",
          });
        }

        if (user.role !== "admin") {
          console.error("❌ isAdmin: User is not admin. Role:", user.role);
          return res.status(403).json({
            success: false,
            message: "Admin access required",
          });
        }

        console.log("✅ isAdmin: User authorized as admin:", user.email);
        next();
      } catch (error) {
        console.error("❌ isAdmin middleware error:", error);
        res.status(500).json({
          success: false,
          message: "Authorization error",
          error: error.message,
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
          console.error("Send notification error:", error);
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
          console.error("Send bulk notifications error:", error);
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
          console.error("Send to course students error:", error);
        }
      },
    };

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

    // TEMPORARY DEBUG ROUTE - Add this before your stats route
    app.get("/admin/debug/token", authenticateToken, async (req, res) => {
      try {
        console.log("🔍 Debug: Token user data:", req.user);

        // Check if userId exists and is valid
        const userId = req.user?.userId;
        const isValid = userId ? ObjectId.isValid(userId) : false;

        res.json({
          success: true,
          debug: {
            userId: userId,
            isValid: isValid,
            user: req.user,
          },
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // 7. GET user statistics for dashboard
    // 7. GET user statistics for dashboard (FIXED)
    // ============= FIXED USER STATS ROUTE =============
    // 7. GET user statistics for dashboard
    // 7. GET user statistics for dashboard (FIXED WITH ERROR HANDLING)
    // ============= FIXED USER STATS ROUTE =============
    // ============= IMPROVED USER STATS ROUTE =============
    app.get(
      "/admin/users/stats",
      authenticateToken,
      isAdmin,
      async (req, res) => {
        try {
          console.log("📊 Fetching user statistics...");

          // Verify userCollection exists
          if (!userCollection) {
            console.error("❌ userCollection is not defined!");
            return res.status(500).json({
              success: false,
              message: "Database collection not initialized",
            });
          }

          // Get total users count
          const totalUsers = await userCollection.countDocuments();
          console.log(`✅ Total users found: ${totalUsers}`);

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
            console.log("⚠️ Status field may not exist, using defaults");
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
            console.log("⚠️ Role field may not exist");
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

          console.log("✅ Stats calculated:", stats);

          res.json({
            success: true,
            stats: stats,
          });
        } catch (error) {
          console.error("❌ Get user stats error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to fetch user statistics",
            error: error.message,
          });
        }
      },
    );

    // 1. GET all users with pagination and filters
    // 1. GET all users with pagination and filters (UPDATED)
    // ============= GET ALL USERS WITH STATS =============
    // ============= GET ALL USERS WITH STATS =============
    app.get("/admin/users", authenticateToken, isAdmin, async (req, res) => {
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

        console.log("🔍 Fetching users with query:", JSON.stringify(query));

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

        console.log(`✅ Found ${users.length} users`);

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
              console.log(
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
        console.error("❌ Get users error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch users",
          error: error.message,
        });
      }
    });

    // 6. BULK user operations
    app.post(
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
          console.error("Bulk action error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to perform bulk action",
          });
        }
      },
    );

    // ============= ADD EMAIL LOGS ROUTE (Admin only) =============
    app.get("/admin/email-logs", authenticateToken, async (req, res) => {
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
        console.error("Get email logs error:", error);
        res
          .status(500)
          .json({ success: false, message: "Failed to get email logs" });
      }
    });

    // ============= ADMIN USER MANAGEMENT ROUTES =============

    // 2. GET single user details with full info
    // ============= FIXED GET SINGLE USER DETAILS ROUTE =============
    app.get(
      "/admin/users/:userId",
      authenticateToken,
      isAdmin,
      async (req, res) => {
        try {
          const { userId } = req.params;

          console.log("🔍 Fetching user details for ID:", userId);

          // Validate if userId is a valid ObjectId
          if (!ObjectId.isValid(userId)) {
            console.log("❌ Invalid user ID format:", userId);
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
          console.error("Get user details error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to fetch user details",
            error: error.message,
          });
        }
      },
    );

    // 3. UPDATE user role
    app.put(
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
          console.log(
            `User ${userId} role changed to ${role} by admin ${req.user.userId}`,
          );

          res.json({
            success: true,
            message: "User role updated successfully",
          });
        } catch (error) {
          console.error("Update user role error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to update user role",
          });
        }
      },
    );

    // 4. UPDATE user status (active/suspended/blocked)
    app.put(
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
          console.error("Update user status error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to update user status",
          });
        }
      },
    );

    // 5. DELETE user (cascade delete)
    app.delete(
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

              console.log(
                `User ${userId} and all related data deleted by admin ${req.user.userId}`,
              );
            });

            await session.commitTransaction();

            res.json({
              success: true,
              message: "User and all related data deleted successfully",
            });
          } finally {
            await session.endSession();
          }
        } catch (error) {
          console.error("Delete user error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to delete user",
          });
        }
      },
    );

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

        // ===== PASSWORD STRENGTH VALIDATION =====
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

        // ===== PASSWORD STRENGTH VALIDATION =====
        if (newPassword.length < 6) {
          return res.status(400).json({
            success: false,
            message: "Password must be at least 6 characters long",
          });
        }

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
    // ============= OPTIMIZED USER PROFILE ROUTE =============
    app.get("/users/profile", authenticateToken, async (req, res) => {
      try {
        const userId = req.user.userId;

        console.log("📋 Fetching profile for user:", userId);

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

        console.log("✅ Profile fetched successfully for:", user.email);

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
        console.error("❌ Get profile error:", error);
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
    // Enroll in a course (UPDATED WITH NOTIFICATION)
    // app.post("/users/enroll/:courseId", authenticateToken, async (req, res) => {
    //   try {
    //     const { courseId } = req.params;
    //     const userId = req.user.userId;

    //     // Check if course exists
    //     const course = await courseCollection.findOne({
    //       _id: new ObjectId(courseId),
    //     });

    //     if (!course) {
    //       return res
    //         .status(404)
    //         .json({ success: false, message: "Course not found" });
    //     }

    //     // Check if already enrolled
    //     const user = await userCollection.findOne({
    //       _id: new ObjectId(userId),
    //       "enrolledCourses.courseId": new ObjectId(courseId),
    //     });

    //     if (user) {
    //       return res.status(400).json({
    //         success: false,
    //         message: "Already enrolled in this course",
    //       });
    //     }

    //     // Get course structure for progress tracking
    //     const chapters = await chapterCollection
    //       .find({ courseId: new ObjectId(courseId) })
    //       .toArray();

    //     const lessons = await lessonCollection
    //       .find({ chapterId: { $in: chapters.map((c) => c._id) } })
    //       .toArray();

    //     const topics = await topicCollection
    //       .find({ lessonId: { $in: lessons.map((l) => l._id) } })
    //       .toArray();

    //     const enrollmentData = {
    //       courseId: new ObjectId(courseId),
    //       enrollmentDate: new Date(),
    //       startDate: new Date(),
    //       endDate: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90 days from now
    //       status: "active",
    //       progress: {
    //         overall: 0,
    //         completedChapters: [],
    //         completedLessons: [],
    //         completedTopics: [],
    //         lastAccessed: new Date(),
    //         timeSpent: 0,
    //       },
    //       certificate: {
    //         issued: false,
    //         issueDate: null,
    //         certificateUrl: null,
    //         certificateId: null,
    //       },
    //     };

    //     await userCollection.updateOne(
    //       { _id: new ObjectId(userId) },
    //       { $push: { enrolledCourses: enrollmentData } },
    //     );

    //     // ===== ADD NOTIFICATION =====
    //     await notificationService.sendToUser(userId, {
    //       type: "course",
    //       message: `You have successfully enrolled in '${course.title}'`,
    //       details: "Start your learning journey today!",
    //       actionUrl: `/course/${course.slug || courseId}`,
    //     });

    //     res.json({
    //       success: true,
    //       message: "Successfully enrolled in course",
    //       enrollment: enrollmentData,
    //     });
    //   } catch (error) {
    //     console.error("Enrollment error:", error);
    //     res.status(500).json({
    //       success: false,
    //       message: "Failed to enroll",
    //       error: error.message,
    //     });
    //   }
    // });

    // In your backend/index.js - Update the enrollment route

    // Enroll in a course (UPDATED)
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

        // Calculate end date based on course duration
        const daysToAdd = parseDurationToDays(course.duration);
        const endDate = new Date(Date.now() + daysToAdd * 24 * 60 * 60 * 1000);

        const enrollmentData = {
          courseId: new ObjectId(courseId),
          enrollmentDate: new Date(),
          startDate: new Date(),
          endDate: endDate, // Use calculated date based on course duration
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

        // Send notification
        await notificationService.sendToUser(userId, {
          type: "course",
          message: `You have successfully enrolled in '${course.title}'`,
          details: "Start your learning journey today!",
          actionUrl: `/course/${course.slug || courseId}`,
        });

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

    // Check if course is in wishlist
    app.get(
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
          console.error("Check wishlist error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to check wishlist",
            error: error.message,
          });
        }
      },
    );

    // In your backend/index.js, find the notifications route and update it:

    // Get user notifications (OPTIMIZED)
    app.get("/users/notifications", authenticateToken, async (req, res) => {
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

    // Delete single notification
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

    // Clear all notifications
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

    // Change password (requires authentication)
    app.post("/auth/change-password", authenticateToken, async (req, res) => {
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
        console.error("Change password error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to change password",
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

    // GET single course by ID
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
    // PUT update course (COMPLETE FIX)
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

        console.log("Updating course with identifier:", id);

        // Find the course
        let course;
        if (ObjectId.isValid(id)) {
          course = await courseCollection.findOne({ _id: new ObjectId(id) });
        }
        if (!course) {
          course = await courseCollection.findOne({ slug: id });
        }

        if (!course) {
          return res.status(404).json({
            success: false,
            message: "Course not found",
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

        // Handle slug update only if title changed
        if (title && title !== course.title) {
          const newSlug = generateSlug(title);

          // Check if slug exists for a DIFFERENT course
          const existingCourse = await courseCollection.findOne({
            slug: newSlug,
            _id: { $ne: course._id },
          });

          if (existingCourse) {
            // Make slug unique
            let counter = 1;
            let uniqueSlug = `${newSlug}-${counter}`;

            while (
              await courseCollection.findOne({
                slug: uniqueSlug,
                _id: { $ne: course._id },
              })
            ) {
              counter++;
              uniqueSlug = `${newSlug}-${counter}`;
            }

            updateData.slug = uniqueSlug;
            console.log(`Generated unique slug: ${uniqueSlug}`);
          } else {
            updateData.slug = newSlug;
            console.log(`Using new slug: ${newSlug}`);
          }
        }

        const result = await courseCollection.updateOne(
          { _id: course._id },
          { $set: updateData },
        );

        console.log("Update result:", result);

        res.status(200).json({
          success: true,
          message: "Course updated successfully",
          slug: updateData.slug || course.slug, // Return the new slug if changed
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

    // GET all lessons (with optional filtering)
    app.get("/lessons", async (req, res) => {
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

        console.log(`Found ${lessons.length} lessons`);
        res.json({ success: true, lessons });
      } catch (error) {
        console.error("Get all lessons error:", error);
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

    // POST create new lesson (UPDATED WITH NOTIFICATION)
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

        // ===== ADD NOTIFICATION TO ALL ENROLLED STUDENTS =====
        const course = await courseCollection.findOne({
          _id: chapter.courseId,
        });
        await notificationService.sendToCourseStudents(chapter.courseId, {
          type: "course",
          message: `📚 New lesson available: '${title}'`,
          details: `Check out the new content in ${course.title}`,
          actionUrl: `/course/${course.slug || chapter.courseId}`,
        });

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

    // ============= INSTRUCTOR ANNOUNCEMENT ROUTE =============
    // Send announcement to all enrolled students
    app.post(
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
          console.error("Send announcement error:", error);
          res.status(500).json({
            success: false,
            message: "Failed to send announcement",
            error: error.message,
          });
        }
      },
    );

    // Get enrolled students count for a course
    // Get enrolled students count for a course
    app.get("/courses/:courseId/enrolled-count", async (req, res) => {
      try {
        const { courseId } = req.params;

        // Validate courseId
        if (!ObjectId.isValid(courseId)) {
          return res.status(400).json({
            success: false,
            message: "Invalid course ID format",
          });
        }

        // Count users who have this course in their enrolledCourses
        const count = await db.collection("users").countDocuments({
          "enrolledCourses.courseId": new ObjectId(courseId),
        });

        res.json({
          success: true,
          count: count,
        });
      } catch (error) {
        console.error("Get enrolled count error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to get enrolled count",
          error: error.message,
        });
      }
    });

    // 1. Create bKash payment (initialize payment)
    app.post("/payments/bkash/create", authenticateToken, async (req, res) => {
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
        console.error("bKash create payment error:", error);
        res.status(500).json({
          success: false,
          message: "Failed to create payment",
          error: error.message,
        });
      }
    });

    // 2. bKash Callback URL (handles payment response)
    // ============= UPDATE THE CALLBACK HANDLER =============
    app.get("/payments/bkash/callback", async (req, res) => {
      try {
        const { paymentID, status } = req.query;

        console.log("📞 bKash Callback received:", { paymentID, status });

        if (status === "success" && paymentID) {
          // First, find the payment by paymentID to get merchantInvoiceNumber
          const payment = await paymentCollection.findOne({
            bkashPaymentID: paymentID,
          });

          if (!payment) {
            console.error("❌ Payment not found for paymentID:", paymentID);
            return res.redirect(
              `${process.env.BKASH_FRONTEND_URL}/payment/failed?error=payment_not_found`,
            );
          }

          console.log("✅ Found payment record:", {
            merchantInvoiceNumber: payment.merchantInvoiceNumber,
            amount: payment.amount,
          });

          // Execute payment
          const executeResponse = await executeBkashPayment(paymentID);

          if (executeResponse.success && executeResponse.data) {
            // Make sure we have the trxID
            const bKashData = executeResponse.data;

            if (!bKashData.trxID) {
              console.error("❌ No trxID in bKash response:", bKashData);
              return res.redirect(
                `${process.env.BKASH_FRONTEND_URL}/payment/failed?error=no_transaction_id`,
              );
            }

            console.log(
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
            console.error(
              "❌ Payment execution failed:",
              executeResponse.error,
            );
            return res.redirect(
              `${process.env.BKASH_FRONTEND_URL}/payment/failed?invoice=${payment.merchantInvoiceNumber}`,
            );
          }
        } else {
          // Payment failed or cancelled
          console.log("❌ Payment failed or cancelled:", { paymentID, status });

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
        console.error("❌ bKash callback error:", error);
        res.redirect(`${process.env.BKASH_FRONTEND_URL}/payment/error`);
      }
    });

    // Helper function to execute bKash payment
    async function executeBkashPayment(paymentID) {
      try {
        console.log("🔄 Executing bKash payment for paymentID:", paymentID);

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
        console.log("✅ Got execution token");

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

        console.log("✅ bKash execute response received:", {
          trxID: executeResponse.data.trxID,
          amount: executeResponse.data.amount,
          paymentID: executeResponse.data.paymentID,
        });

        return { success: true, data: executeResponse.data };
      } catch (error) {
        console.error(
          "❌ Execute bKash payment error:",
          error.response?.data || error.message,
        );
        return { success: false, error: error.message };
      }
    }

    // 3. Query payment status
    // 3. Query payment status (UPDATED with more data)
    app.get(
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
          console.error("Payment status error:", error);
          res
            .status(500)
            .json({ success: false, message: "Failed to get payment status" });
        }
      },
    );

    // 4. Get payment history for user
    app.get("/payments/history", authenticateToken, async (req, res) => {
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
        console.error("Payment history error:", error);
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
            color: rgba(255,255,255,0.9);
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
              <p>📧 Email: support@lmsacademy.com<br>
              📞 Phone: +880 1234-567890<br>
              💬 Live Chat: Available 24/7 on our website</p>
            </div>
          </div>
          
          <div class="footer">
            <div class="social-links">
              <a href="#">Facebook</a> • 
              <a href="#">Twitter</a> • 
              <a href="#">LinkedIn</a> • 
              <a href="#">Instagram</a>
            </div>
            <p>© ${new Date().getFullYear()} LMS Academy. All rights reserved.</p>
            <p>123 Gulshan Avenue, Dhaka 1212, Bangladesh</p>
            <p style="font-size: 12px;">This is a system generated email. Please do not reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `,
      }),

      // Invoice PDF Template (for attachment - optional)
      invoiceTemplate: (data) => `
    LMS ACADEMY - OFFICIAL RECEIPT
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
          console.log(
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
            instructorName: courseData.instructorName || "Dr. Smith",
          };

          // Get email template
          const template = emailTemplates.paymentConfirmation(emailData);

          // Create PDF invoice (optional - you'd need a PDF library like pdfkit)
          // const pdfBuffer = await generatePDFInvoice(emailData);

          // Send email
          const mailOptions = {
            from: {
              name: "LMS Academy",
              address: process.env.EMAIL_USER,
            },
            to: userData.email,
            subject: template.subject,
            html: template.html,
            // attachments: [
            //   {
            //     filename: `invoice-${paymentData.merchantInvoiceNumber}.pdf`,
            //     content: pdfBuffer,
            //     contentType: 'application/pdf'
            //   }
            // ]
          };

          const info = await transporter.sendMail(mailOptions);
          console.log("✅ Payment confirmation email sent:", info.messageId);

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
          console.error("❌ Failed to send payment confirmation email:", error);

          // Log failed email
          await db.collection("emailLogs").insertOne({
            type: "payment_confirmation",
            userId: userData?._id,
            email: userData?.email,
            merchantInvoiceNumber: paymentData?.merchantInvoiceNumber,
            error: error.message,
            attemptedAt: new Date(),
            status: "failed",
          });

          return { success: false, error: error.message };
        }
      },

      // Send payment receipt to admin (optional)
      sendAdminNotification: async (paymentData, userData, courseData) => {
        try {
          const adminEmail = process.env.ADMIN_EMAIL || "admin@lmsacademy.com";

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
          console.log("✅ Admin notification sent");
        } catch (error) {
          console.error("❌ Failed to send admin notification:", error);
        }
      },
    };

    // ============= UPDATE THE HANDLE SUCCESSFUL PAYMENT FUNCTION =============
    // Replace your existing handleSuccessfulPayment function with this:
    // ============= UPDATE THE HANDLE SUCCESSFUL PAYMENT FUNCTION =============
    async function handleSuccessfulPayment(bKashData, merchantInvoiceNumber) {
      try {
        console.log("💰 Handling successful payment:", {
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

        console.log("✅ Payment record updated:", updateResult);

        // Find the updated payment to get userId and courseId
        const payment = await paymentCollection.findOne({
          merchantInvoiceNumber,
        });

        if (!payment) {
          console.error(
            "❌ Payment not found after update:",
            merchantInvoiceNumber,
          );
          return;
        }

        console.log("✅ Found payment record:", {
          userId: payment.userId,
          courseId: payment.courseId,
          amount: payment.amount,
        });

        // Get course details
        const course = await courseCollection.findOne({
          _id: payment.courseId,
        });
        if (!course) {
          console.error("❌ Course not found:", payment.courseId);
          return;
        }

        // Get user details
        const user = await userCollection.findOne({ _id: payment.userId });
        if (!user) {
          console.error("❌ User not found:", payment.userId);
          return;
        }

        console.log("✅ Found course and user:", {
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

        console.log("✅ User enrolled successfully:", enrollResult);

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
          console.log("✅ Payment confirmation email sent");
        } catch (emailError) {
          console.error("❌ Failed to send email:", emailError);
        }

        // Optional: Send admin notification
        try {
          await paymentEmailService.sendAdminNotification(
            { ...payment, trxID: bKashData.trxID },
            user,
            course,
          );
        } catch (adminError) {
          console.error("❌ Failed to send admin notification:", adminError);
        }
      } catch (error) {
        console.error("❌ Handle successful payment error:", error);
      }
    }

    // ============= ADD PAYMENT RECEIPT DOWNLOAD ROUTE =============

    // Download payment receipt
    // Download payment receipt (UPDATED)
    //     app.get(
    //       "/payments/receipt/:merchantInvoiceNumber",
    //       authenticateToken,
    //       async (req, res) => {
    //         try {
    //           const { merchantInvoiceNumber } = req.params;
    //           const userId = req.user.userId;

    //           const payment = await paymentCollection.findOne({
    //             merchantInvoiceNumber,
    //             userId: new ObjectId(userId),
    //           });

    //           if (!payment) {
    //             return res
    //               .status(404)
    //               .json({ success: false, message: "Payment not found" });
    //           }

    //           const course = await courseCollection.findOne({
    //             _id: payment.courseId,
    //           });
    //           const user = await userCollection.findOne({ _id: userId });

    //           // Generate receipt with actual transaction ID
    //           const receipt = `
    // ===========================================
    //           LMS ACADEMY
    //       OFFICIAL PAYMENT RECEIPT
    // ===========================================

    // Receipt No: ${payment.merchantInvoiceNumber}
    // Date: ${new Date(payment.updatedAt || payment.createdAt).toLocaleDateString("en-BD", { timeZone: "Asia/Dhaka" })}
    // Time: ${new Date(payment.updatedAt || payment.createdAt).toLocaleTimeString("en-BD", { timeZone: "Asia/Dhaka" })}

    // -------------------------------------------
    // STUDENT INFORMATION
    // -------------------------------------------
    // Name: ${user?.name || "N/A"}
    // Email: ${user?.email || "N/A"}
    // Student ID: ${user?.uniqueId || "N/A"}

    // -------------------------------------------
    // PAYMENT DETAILS
    // -------------------------------------------
    // Transaction ID: ${payment.trxID || payment.paymentData?.trxID || "N/A"}
    // Payment Method: bKash
    // Amount: ৳${payment.amount?.toLocaleString() || "0"}
    // Status: PAID ✓

    // -------------------------------------------
    // COURSE INFORMATION
    // -------------------------------------------
    // Course: ${course?.title || "N/A"}
    // Duration: ${course?.duration || "N/A"}
    // Level: ${course?.level || "N/A"}

    // -------------------------------------------
    // SUMMARY
    // -------------------------------------------
    // Subtotal: ৳${payment.amount?.toLocaleString() || "0"}
    // VAT (0%): ৳0
    // Total Paid: ৳${payment.amount?.toLocaleString() || "0"}

    // ===========================================
    // This is a computer generated receipt.
    // For any queries, contact: support@lmsacademy.com
    // ===========================================
    //     `;

    //           res.setHeader("Content-Type", "text/plain");
    //           res.setHeader(
    //             "Content-Disposition",
    //             `attachment; filename=receipt-${merchantInvoiceNumber}.txt`,
    //           );
    //           res.send(receipt);
    //         } catch (error) {
    //           console.error("Download receipt error:", error);
    //           res
    //             .status(500)
    //             .json({ success: false, message: "Failed to download receipt" });
    //         }
    //       },
    //     );

    // ============= PDF GENERATION WITH PDFKIT =============

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
              Author: "LMS Academy",
              Subject: "Course Payment Receipt",
              Keywords: "receipt, payment, lms",
              Creator: "LMS Academy",
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
            .text("LMS ACADEMY", { align: "center" });

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
            .text("123 Gulshan Avenue, Dhaka 1212, Bangladesh", {
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
              "For any queries, contact: support@lmsacademy.com | +880 1234-567890",
              { align: "center" },
            )
            .text(
              `© ${new Date().getFullYear()} LMS Academy. All rights reserved.`,
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

    // ===== UPDATE THE DOWNLOAD RECEIPT ROUTE =====
    // ===== UPDATED PDF RECEIPT DOWNLOAD ROUTE =====
    app.get(
      "/payments/receipt/:merchantInvoiceNumber",
      authenticateToken,
      async (req, res) => {
        try {
          const { merchantInvoiceNumber } = req.params;
          const userId = req.user.userId;

          console.log("📄 Generating PDF receipt for:", {
            merchantInvoiceNumber,
            userId,
          });

          // Find payment
          const payment = await paymentCollection.findOne({
            merchantInvoiceNumber,
            userId: new ObjectId(userId),
          });

          if (!payment) {
            console.error("❌ Payment not found:", merchantInvoiceNumber);
            return res
              .status(404)
              .json({ success: false, message: "Payment not found" });
          }

          console.log("✅ Payment found:", {
            id: payment._id,
            amount: payment.amount,
            trxID: payment.trxID,
          });

          // Get course details
          const course = await courseCollection.findOne({
            _id: payment.courseId,
          });
          if (!course) {
            console.error("❌ Course not found:", payment.courseId);
          }

          // Get user details
          const user = await userCollection.findOne({ _id: userId });
          if (!user) {
            console.error("❌ User not found:", userId);
          }

          console.log("✅ User and course found:", {
            userName: user?.name,
            userEmail: user?.email,
            courseTitle: course?.title,
          });

          try {
            // Generate PDF
            const pdfBuffer = await generatePDFReceipt(payment, user, course);

            console.log(
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
            console.error("❌ PDF generation error:", pdfError);

            // Fallback to text receipt if PDF fails
            const fallbackReceipt = `
===========================================
          LMS ACADEMY
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
          console.error("❌ Download receipt error:", error);
          res
            .status(500)
            .json({ success: false, message: "Failed to download receipt" });
        }
      },
    );

    // ===== UPDATE THE PAYMENT STATUS ROUTE =====

    app.get(
      "/payments/status/:merchantInvoiceNumber",
      authenticateToken,
      async (req, res) => {
        try {
          const { merchantInvoiceNumber } = req.params;
          const userId = req.user.userId;

          console.log("🔍 Checking payment status for:", merchantInvoiceNumber);

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
              // Student information -直接从user对象获取
              studentName: user?.name || "Student",
              studentEmail: user?.email || "student@example.com",
              studentId: user?.uniqueId || "N/A",
              // Course information
              courseTitle: course?.title || "Course",
              courseDuration: course?.duration || "Self-paced",
              courseLevel: course?.level || "All Levels",
            },
          };

          console.log("✅ Sending payment status response with student:", {
            name: responseData.payment.studentName,
            email: responseData.payment.studentEmail,
          });

          res.json(responseData);
        } catch (error) {
          console.error("❌ Payment status error:", error);
          res
            .status(500)
            .json({ success: false, message: "Failed to get payment status" });
        }
      },
    );

    // ============= TESTIMONIALS API =============

    // PUBLIC: Get approved testimonials for homepage
    // GET random testimonials
    app.get("/testimonials/random", async (req, res) => {
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
        console.error("Error fetching random testimonials:", error);
        res.status(500).json({ message: "Server error" });
      }
    });

    app.get("/testimonials", async (req, res) => {
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
        console.error("Error fetching testimonials:", error);
        res.status(500).json({ message: "Server error" });
      }
    });

    // PUBLIC: Submit a testimonial (for registered users)
    app.post("/testimonials", authenticateToken, async (req, res) => {
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
        console.error("Error submitting testimonial:", error);
        res.status(500).json({ message: "Server error" });
      }
    });

    // ADMIN: Get all testimonials with pagination and filters
    app.get(
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
          console.error("Error fetching admin testimonials:", error);
          res.status(500).json({ message: "Server error" });
        }
      },
    );

    // ADMIN: Update testimonial status/approval
    app.put(
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
          console.error("Error updating testimonial:", error);
          res.status(500).json({ message: "Server error" });
        }
      },
    );

    // ADMIN: Delete testimonial
    app.delete(
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
          console.error("Error deleting testimonial:", error);
          res.status(500).json({ message: "Server error" });
        }
      },
    );

    // ADMIN: Bulk actions on testimonials
    app.post(
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
          console.error("Error in bulk action:", error);
          res.status(500).json({ message: "Server error" });
        }
      },
    );

    // Start server
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
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
