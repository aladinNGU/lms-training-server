// backend/index.js
const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
// const url = 'mongodb://localhost:27017';

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.zn6isea.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();
    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Ensures that the client will close when you finish/error
    await client.close();
  }
}
run().catch(console.dir);

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

// ============= COURSE ROUTES =============

// GET all courses
app.get("/courses", async (req, res) => {
  try {
    const courses = await db
      .collection("courses")
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
    const course = await db
      .collection("courses")
      .findOne({ slug: req.params.slug });

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
    const { title, description, price, level, duration, thumbnail } = req.body;

    // Validate required fields
    if (!title || !description || !price) {
      return res.status(400).json({
        success: false,
        message: "Title, description and price are required",
      });
    }

    // Generate unique slug
    const slug = await createUniqueSlug(title, db.collection("courses"));

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

    const result = await db.collection("courses").insertOne(courseData);

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
    const { title, description, price, level, duration, thumbnail, status } =
      req.body;

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
      updateData.slug = await createUniqueSlug(title, db.collection("courses"));
    }

    const result = await db
      .collection("courses")
      .updateOne({ _id: new ObjectId(id) }, { $set: updateData });

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

    const result = await db.collection("courses").deleteOne({
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

// ============= BULK COURSE CREATION =============

// POST create multiple courses at once (for seeding)
app.post("/api/courses/bulk", async (req, res) => {
  try {
    const courses = req.body.courses;

    if (!Array.isArray(courses)) {
      return res.status(400).json({
        success: false,
        message: "Courses must be an array",
      });
    }

    const createdCourses = [];

    for (const courseData of courses) {
      const slug = await createUniqueSlug(
        courseData.title,
        db.collection("courses"),
      );

      const course = {
        ...courseData,
        slug,
        price: parseFloat(courseData.price),
        createdAt: new Date(),
        updatedAt: new Date(),
        status: "published",
      };

      const result = await db.collection("courses").insertOne(course);
      createdCourses.push({ ...course, _id: result.insertedId });
    }

    res.status(201).json({
      success: true,
      message: `${createdCourses.length} courses created successfully`,
      courses: createdCourses,
    });
  } catch (error) {
    console.error("Bulk create error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create courses",
      error: error.message,
    });
  }
});

// ============= SEED DATA ENDPOINT =============

// GET seed sample courses
app.get("/api/seed/courses", async (req, res) => {
  try {
    const sampleCourses = [
      {
        title: "Full Stack Web Development",
        description:
          "Complete web development course from basics to advanced. Learn HTML, CSS, JavaScript, React, Node.js and more.",
        price: 99.99,
        level: "beginner",
        duration: "24 weeks",
        thumbnail:
          "https://images.unsplash.com/photo-1587620962725-abab7fe55159?w=300&h=200&fit=crop",
      },
      {
        title: "JavaScript Mastery",
        description:
          "Deep dive into JavaScript. Learn ES6+, async programming, design patterns, and modern JavaScript features.",
        price: 79.99,
        level: "intermediate",
        duration: "12 weeks",
        thumbnail:
          "https://images.unsplash.com/photo-1579468118864-1b9ea3c0db4a?w=300&h=200&fit=crop",
      },
      {
        title: "React.js Complete Guide",
        description:
          "Build powerful web applications with React. Hooks, context, Redux, routing, and best practices.",
        price: 89.99,
        level: "intermediate",
        duration: "16 weeks",
        thumbnail:
          "https://images.unsplash.com/photo-1633356122544-f134324a6cee?w=300&h=200&fit=crop",
      },
      {
        title: "Python for Beginners",
        description:
          "Start your programming journey with Python. Learn syntax, data structures, OOP, and build real projects.",
        price: 69.99,
        level: "beginner",
        duration: "10 weeks",
        thumbnail:
          "https://images.unsplash.com/photo-1526379095098-400a3eae2f55?w=300&h=200&fit=crop",
      },
      {
        title: "MongoDB Masterclass",
        description:
          "Master MongoDB from basics to advanced. Learn aggregation, indexing, replication, and sharding.",
        price: 79.99,
        level: "intermediate",
        duration: "8 weeks",
        thumbnail:
          "https://images.unsplash.com/photo-1623479322729-28b25c16b011?w=300&h=200&fit=crop",
      },
      {
        title: "Node.js API Development",
        description:
          "Build scalable RESTful APIs with Node.js, Express, and MongoDB. Learn authentication, file upload, and deployment.",
        price: 84.99,
        level: "intermediate",
        duration: "10 weeks",
        thumbnail:
          "https://images.unsplash.com/photo-1627398242454-45a1465c2479?w=300&h=200&fit=crop",
      },
    ];

    const createdCourses = [];

    for (const courseData of sampleCourses) {
      const slug = await createUniqueSlug(
        courseData.title,
        db.collection("courses"),
      );

      const course = {
        ...courseData,
        slug,
        totalChapters: 0,
        totalLessons: 0,
        totalTopics: 0,
        status: "published",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await db.collection("courses").insertOne(course);
      createdCourses.push({ ...course, _id: result.insertedId });
    }

    res.status(201).json({
      success: true,
      message: `${createdCourses.length} sample courses created successfully`,
      courses: createdCourses,
    });
  } catch (error) {
    console.error("Seed error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to seed courses",
      error: error.message,
    });
  }
});

// ============= SEARCH ENDPOINTS =============

// GET search courses
app.get("/api/courses/search/:query", async (req, res) => {
  try {
    const { query } = req.params;

    const courses = await db
      .collection("courses")
      .find({
        $and: [
          { status: "published" },
          {
            $or: [
              { title: { $regex: query, $options: "i" } },
              { description: { $regex: query, $options: "i" } },
            ],
          },
        ],
      })
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).json({
      success: true,
      count: courses.length,
      courses,
    });
  } catch (error) {
    console.error("Search error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to search courses",
      error: error.message,
    });
  }
});

// GET courses by level
app.get("/api/courses/level/:level", async (req, res) => {
  try {
    const { level } = req.params;
    const validLevels = ["beginner", "intermediate", "advanced"];

    if (!validLevels.includes(level)) {
      return res.status(400).json({
        success: false,
        message: "Invalid level. Must be beginner, intermediate, or advanced",
      });
    }

    const courses = await db
      .collection("courses")
      .find({ status: "published", level })
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).json({
      success: true,
      count: courses.length,
      courses,
    });
  } catch (error) {
    console.error("Get by level error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch courses by level",
      error: error.message,
    });
  }
});

// ============= STATS ENDPOINT =============

// GET course statistics
app.get("/api/stats/courses", async (req, res) => {
  try {
    const totalCourses = await db
      .collection("courses")
      .countDocuments({ status: "published" });

    const levelStats = await db
      .collection("courses")
      .aggregate([
        { $match: { status: "published" } },
        { $group: { _id: "$level", count: { $sum: 1 } } },
      ])
      .toArray();

    const priceStats = await db
      .collection("courses")
      .aggregate([
        { $match: { status: "published" } },
        {
          $group: {
            _id: null,
            avgPrice: { $avg: "$price" },
            minPrice: { $min: "$price" },
            maxPrice: { $max: "$price" },
          },
        },
      ])
      .toArray();

    res.status(200).json({
      success: true,
      stats: {
        totalCourses,
        byLevel: levelStats,
        pricing: priceStats[0] || { avgPrice: 0, minPrice: 0, maxPrice: 0 },
      },
    });
  } catch (error) {
    console.error("Stats error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch stats",
      error: error.message,
    });
  }
});

// ============= HEALTH CHECK =============

app.get("/api/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Server is running",
    timestamp: new Date(),
    database: db ? "connected" : "disconnected",
  });
});

// ============= ERROR HANDLING =============

// 404 handler
app.use("*", (req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("Global error:", err.stack);
  res.status(500).json({
    success: false,
    message: "Something went wrong!",
    error: err.message,
  });
});

// ============= START SERVER =============

async function startServer() {
  await connectDB();

  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log("Available endpoints:");
    console.log("  GET    /api/health");
    console.log("  GET    /api/courses");
    console.log("  GET    /api/courses/:slug");
    console.log("  POST   /api/courses");
    console.log("  PUT    /api/courses/:id");
    console.log("  DELETE /api/courses/:id");
    console.log("  POST   /api/courses/bulk");
    console.log("  GET    /api/seed/courses");
    console.log("  GET    /api/courses/search/:query");
    console.log("  GET    /api/courses/level/:level");
    console.log("  GET    /api/stats/courses");
  });
}

startServer();
