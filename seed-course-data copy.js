// backend/seed-course-data.js
const { MongoClient, ObjectId } = require("mongodb");
require("dotenv").config();

async function seedCourseData() {
  const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.zn6isea.mongodb.net/?appName=Cluster0`;
  const client = new MongoClient(uri);

  try {
    await client.connect();
    console.log("Connected to MongoDB");

    const db = client.db("lmsDB");

    // Create collections if they don't exist
    try {
      await db.createCollection("chapters");
      await db.createCollection("lessons");
      await db.createCollection("topics");
      console.log("Collections created successfully");
    } catch (error) {
      console.log("Collections already exist, proceeding...");
    }

    const courseCollection = db.collection("courses");
    const chapterCollection = db.collection("chapters");
    const lessonCollection = db.collection("lessons");
    const topicCollection = db.collection("topics");

    // Create indexes for better performance
    try {
      await chapterCollection.createIndex({ courseId: 1, order: 1 });
      await lessonCollection.createIndex({ chapterId: 1, order: 1 });
      await topicCollection.createIndex({ lessonId: 1, order: 1 });
      console.log("Indexes created");
    } catch (error) {
      console.log("Indexes may already exist");
    }

    // Find the course with flexible matching
    const course = await courseCollection.findOne({
      title: { $regex: "fulll", $options: "i" },
    });

    if (!course) {
      console.log("❌ Course 'fulll' not found!");
      console.log("Available courses:");
      const allCourses = await courseCollection.find({}).toArray();
      if (allCourses.length === 0) {
        console.log("No courses found. Please create a course first.");
      } else {
        allCourses.forEach((c) => console.log(`- ${c.title}`));
      }
      return;
    }

    console.log(`✅ Found course: ${course.title} (ID: ${course._id})`);

    // Clear existing data for this course (optional - removes old data)
    console.log("Clearing existing course data...");
    const chapters = await chapterCollection
      .find({ courseId: course._id })
      .toArray();
    for (const chapter of chapters) {
      const lessons = await lessonCollection
        .find({ chapterId: chapter._id })
        .toArray();
      for (const lesson of lessons) {
        await topicCollection.deleteMany({ lessonId: lesson._id });
      }
      await lessonCollection.deleteMany({ chapterId: chapter._id });
    }
    await chapterCollection.deleteMany({ courseId: course._id });
    console.log("Existing data cleared");

    // Chapter 1: HTML, CSS and Github Basics
    const chapter1 = {
      courseId: course._id,
      title: "HTML, CSS and Github Basics",
      description: "Learn the fundamentals of web development",
      order: 1,
      createdAt: new Date(),
    };

    const chapter1Result = await chapterCollection.insertOne(chapter1);
    console.log(`✅ Created chapter: ${chapter1.title}`);

    // Lesson 1: Learn and Explore HTML
    const lesson1 = {
      chapterId: chapter1Result.insertedId,
      title: "Learn and Explore HTML",
      description: "Learn the building blocks of web development with HTML",
      order: 1,
      createdAt: new Date(),
    };

    const lesson1Result = await lessonCollection.insertOne(lesson1);
    console.log(`  ✅ Created lesson: ${lesson1.title}`);

    // Topics for Lesson 1 (9 topics as in your image)
    const topics = [
      {
        lessonId: lesson1Result.insertedId,
        title: "HTML: Explore VSCode and what is HTML",
        content: {
          description:
            "Learn about VSCode editor and understand what HTML is and its role in web development.",
          duration: "10 minutes",
          readingTime: "5 minutes",
        },
        order: 1,
        createdAt: new Date(),
      },
      // ... (rest of your 9 topics - keep them as they are)
    ];

    // Insert topics
    if (topics.length > 0) {
      const topicsResult = await topicCollection.insertMany(topics);
      console.log(
        `    ✅ Created ${topicsResult.insertedCount} topics for lesson`,
      );
    }

    // ============= ADD RICH TOPIC HERE (INSIDE THE FUNCTION) =============
    const richTopic = {
      lessonId: lesson1Result.insertedId,
      title: "HTML: Complete Introduction with Examples",
      order: 10, // Add as 10th topic after the 9 basic ones
      content: {
        description:
          "A comprehensive introduction to HTML with code examples, interactive demos, and quizzes.",
        contentBlocks: [
          {
            type: "text",
            content:
              "Welcome to HTML! In this lesson, you'll learn the fundamentals of web development.",
            style: "heading",
          },
          {
            type: "note",
            variant: "tip",
            title: "Before You Start",
            content:
              "Make sure you have VS Code installed. It's the best editor for web development!",
          },
          {
            type: "image",
            url: "https://images.unsplash.com/photo-1587620962725-abab7fe55159?w=800",
            caption: "VS Code editor with HTML file",
            alt: "VS Code interface",
          },
          {
            type: "text",
            content: "Here's a basic HTML template to get started:",
            style: "subheading",
          },
          {
            type: "code",
            language: "html",
            code: "<!DOCTYPE html>\n<html lang='en'>\n<head>\n    <meta charset='UTF-8'>\n    <meta name='viewport' content='width=device-width, initial-scale=1.0'>\n    <title>My First Page</title>\n</head>\n<body>\n    <h1>Hello, World!</h1>\n    <p>This is my first HTML page.</p>\n</body>\n</html>",
            caption: "Complete HTML5 template",
            showLineNumbers: true,
          },
          {
            type: "note",
            variant: "info",
            title: "Did You Know?",
            content:
              "The <!DOCTYPE html> declaration tells the browser this is an HTML5 document.",
          },
          {
            type: "list",
            items: [
              "HTML structures content",
              "CSS adds styling",
              "JavaScript adds interactivity",
            ],
            ordered: false,
          },
          {
            type: "component",
            component: "ButtonDemo",
            props: {
              buttonText: "Test Your Knowledge",
              color: "primary",
            },
          },
          {
            type: "quiz",
            question: "Which tag is used for the largest heading?",
            options: ["<h1>", "<heading>", "<h6>", "<head>"],
            correctAnswer: 0,
            explanation:
              "<h1> is the largest heading tag, used for main headings.",
          },
          {
            type: "resource",
            resources: [
              {
                type: "pdf",
                title: "HTML Cheat Sheet",
                url: "/resources/html-cheat-sheet.pdf",
                size: "2.5 MB",
              },
              {
                type: "zip",
                title: "Exercise Files",
                url: "/resources/html-exercises.zip",
                size: "5 MB",
              },
            ],
          },
          {
            type: "divider",
          },
          {
            type: "text",
            content: "Ready to practice? Try the interactive demo below!",
            style: "normal",
          },
          {
            type: "component",
            component: "FormDemo",
            props: {},
          },
        ],
        duration: "15 minutes",
        readingTime: "8 minutes",
      },
    };

    // Insert the rich topic
    await topicCollection.insertOne(richTopic);
    console.log(`    ✅ Created rich topic: ${richTopic.title}`);

    // Add more lessons for Chapter 1
    const moreLessons = [
      {
        chapterId: chapter1Result.insertedId,
        title: "Learn and Explore CSS",
        description: "Master CSS styling and layout techniques",
        order: 2,
        createdAt: new Date(),
      },
      {
        chapterId: chapter1Result.insertedId,
        title: "Learn and Explore HTML/CSS",
        description: "Combine HTML and CSS for beautiful webpages",
        order: 3,
        createdAt: new Date(),
      },
      {
        chapterId: chapter1Result.insertedId,
        title: "Learn about HTML",
        description: "Deep dive into advanced HTML concepts",
        order: 4,
        createdAt: new Date(),
      },
      {
        chapterId: chapter1Result.insertedId,
        title: "Build a beautiful portfolio website",
        description: "Create your first portfolio website project",
        order: 5,
        createdAt: new Date(),
      },
      {
        chapterId: chapter1Result.insertedId,
        title: "Build your own personal website",
        description: "Build and deploy your personal website",
        order: 6,
        createdAt: new Date(),
      },
      {
        chapterId: chapter1Result.insertedId,
        title: "Build your own personal website (Part 2)",
        description: "Continue building and enhance your personal website",
        order: 7,
        createdAt: new Date(),
      },
    ];

    if (moreLessons.length > 0) {
      const lessonsResult = await lessonCollection.insertMany(moreLessons);
      console.log(`  ✅ Created ${lessonsResult.insertedCount} more lessons`);
    }

    // Chapter 2: Responsive Web Layouts
    const chapter2 = {
      courseId: course._id,
      title: "Responsive Web Layouts",
      description:
        "Learn to create responsive websites that work on all devices",
      order: 2,
      createdAt: new Date(),
    };

    const chapter2Result = await chapterCollection.insertOne(chapter2);
    console.log(`✅ Created chapter: ${chapter2.title}`);

    // Add a sample lesson for Chapter 2
    const chapter2Lesson = {
      chapterId: chapter2Result.insertedId,
      title: "Introduction to Responsive Design",
      description: "Learn the fundamentals of responsive web design",
      order: 1,
      createdAt: new Date(),
    };

    await lessonCollection.insertOne(chapter2Lesson);
    console.log(`  ✅ Created lesson: ${chapter2Lesson.title}`);

    // Chapter 3: CSS Frameworks
    const chapter3 = {
      courseId: course._id,
      title: "CSS Frameworks",
      description: "Learn popular CSS frameworks like Bootstrap and Tailwind",
      order: 3,
      createdAt: new Date(),
    };

    await chapterCollection.insertOne(chapter3);
    console.log(`✅ Created chapter: ${chapter3.title}`);

    console.log("\n📊 Seeding Summary:");
    console.log(`Course: ${course.title}`);

    const totalChapters = await chapterCollection.countDocuments({
      courseId: course._id,
    });
    const totalLessons = await lessonCollection.countDocuments({});
    const totalTopics = await topicCollection.countDocuments({});

    console.log(`Total chapters: ${totalChapters}`);
    console.log(`Total lessons: ${totalLessons}`);
    console.log(`Total topics: ${totalTopics}`);

    console.log("\n🎉 Course data seeded successfully!");
  } catch (error) {
    console.error("❌ Error seeding data:", error);
  } finally {
    await client.close();
    console.log("MongoDB connection closed");
  }
}

// Run the seed function
seedCourseData().catch(console.error);
