// GET all courses
// READ all courses with filters
api.get("/courses", async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      category,
      level,
      status,
      search,
      sortBy = "createdAt",
      sortOrder = -1,
    } = req.query;

    const query = {};

    if (category) query.category = category;
    if (level) query.level = level;
    if (status) query.status = status;
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
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
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
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
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
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
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
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
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
        message: "Unauthorized: Only admins and instructors can create courses",
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
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
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
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
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
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
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
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
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
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});
