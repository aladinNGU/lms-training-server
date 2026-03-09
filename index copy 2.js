// backend/index.js
const express = require("express");
const cors = require("cors");
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

    // Create indexes for better performance
    await courseCollection.createIndex({ slug: 1 }, { unique: true });
    await courseCollection.createIndex({ status: 1 });
    await courseCollection.createIndex({ level: 1 });
    await courseCollection.createIndex({ createdAt: -1 });
    await chapterCollection.createIndex({ courseId: 1, order: 1 });
    await lessonCollection.createIndex({ chapterId: 1, order: 1 });
    await topicCollection.createIndex({ lessonId: 1, order: 1 });

    console.log("Database indexes created");

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
    // ============= TOPIC ROUTES =============

    // GET single topic
    app.get("/topics/:topicId", async (req, res) => {
      try {
        const topic = await topicCollection.findOne({
          _id: new ObjectId(req.params.topicId),
        });

        res.json({ success: true, topic });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
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
    // 404 handler for undefined routes - FIXED VERSION
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
