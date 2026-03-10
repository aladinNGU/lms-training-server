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
