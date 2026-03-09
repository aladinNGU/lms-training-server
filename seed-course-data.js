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

    // Clear existing data for this course
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

    // ============= 9 LESSON TOPICS =============
    const topics = [
      {
        lessonId: lesson1Result.insertedId,
        title: "HTML: Explore VSCode and what is HTML",
        content: {
          description:
            "Learn about VSCode editor and understand what HTML is and its role in web development.",
          contentBlocks: [
            {
              type: "text",
              content:
                "Visual Studio Code (VS Code) is a free, lightweight, but powerful source code editor.",
              style: "normal",
            },
            {
              type: "note",
              variant: "tip",
              title: "Download VS Code",
              content:
                "Download VS Code from code.visualstudio.com. It's available for Windows, Mac, and Linux.",
            },
            {
              type: "code",
              language: "html",
              code: "<!DOCTYPE html>\n<html>\n<head>\n  <title>My First Page</title>\n</head>\n<body>\n  <h1>Hello World!</h1>\n</body>\n</html>",
              caption: "Your first HTML document",
            },
          ],
          duration: "10 minutes",
          readingTime: "5 minutes",
        },
        order: 1,
        createdAt: new Date(),
      },
      {
        lessonId: lesson1Result.insertedId,
        title:
          "HTML: Text: Creating paragraphs, Text formatting (b, i, strong, em)",
        content: {
          description:
            "Learn how to create paragraphs and format text using bold, italic, strong, and emphasis tags.",
          contentBlocks: [
            {
              type: "text",
              content:
                "HTML provides several tags for formatting text. Let's explore them:",
              style: "normal",
            },
            {
              type: "code",
              language: "html",
              code: "<p>This is a paragraph.</p>\n<p>This is another paragraph.</p>\n\n<b>Bold text</b>\n<i>Italic text</i>\n<strong>Strong text</strong>\n<em>Emphasized text</em>",
              caption: "Text formatting examples",
            },
            {
              type: "note",
              variant: "info",
              title: "Semantic vs Presentational",
              content:
                "<strong> and <em> are semantic tags (add meaning), while <b> and <i> are presentational (just style).",
            },
          ],
          duration: "15 minutes",
          readingTime: "8 minutes",
        },
        order: 2,
        createdAt: new Date(),
      },
      {
        lessonId: lesson1Result.insertedId,
        title: "HTML: Text: Headings, small, and inline vs block (div, span)",
        content: {
          description:
            "Understand headings from h1 to h6, small text, and the difference between inline and block elements.",
          contentBlocks: [
            {
              type: "code",
              language: "html",
              code: "<h1>Main Heading</h1>\n<h2>Subheading</h2>\n<h3>Section Heading</h3>\n<p>Normal text with <small>small text</small> inside.</p>",
              caption: "Headings and small text",
            },
            {
              type: "text",
              content:
                "Block elements take full width, inline elements only take necessary space.",
              style: "subheading",
            },
            {
              type: "code",
              language: "html",
              code: "<div>This is a block element (div)</div>\n<span>This is an inline element (span)</span>",
              caption: "Block vs Inline example",
            },
          ],
          duration: "12 minutes",
          readingTime: "6 minutes",
        },
        order: 3,
        createdAt: new Date(),
      },
      {
        lessonId: lesson1Result.insertedId,
        title:
          "HTML: List: Container tags, list tags (ol, ul, li), line break, button",
        content: {
          description:
            "Create ordered and unordered lists, use container tags, line breaks, and buttons.",
          contentBlocks: [
            {
              type: "code",
              language: "html",
              code: "<ul>\n  <li>Unordered item 1</li>\n  <li>Unordered item 2</li>\n</ul>\n\n<ol>\n  <li>Ordered item 1</li>\n  <li>Ordered item 2</li>\n</ol>",
              caption: "Lists in HTML",
            },
            {
              type: "component",
              component: "ButtonDemo",
              props: {
                buttonText: "Interactive Button",
                color: "primary",
              },
            },
          ],
          duration: "15 minutes",
          readingTime: "7 minutes",
        },
        order: 4,
        createdAt: new Date(),
      },
      {
        lessonId: lesson1Result.insertedId,
        title:
          "HTML: Link: Creating links with the anchor tag and its attributes (href, target)",
        content: {
          description:
            "Learn to create hyperlinks using anchor tags and understand href and target attributes.",
          contentBlocks: [
            {
              type: "code",
              language: "html",
              code: "<a href='https://www.example.com'>Visit Example.com</a>\n<a href='page2.html' target='_blank'>Open in new tab</a>",
              caption: "Link examples",
            },
            {
              type: "note",
              variant: "tip",
              title: "Target Attribute",
              content: "target='_blank' opens the link in a new tab/window.",
            },
          ],
          duration: "10 minutes",
          readingTime: "5 minutes",
        },
        order: 5,
        createdAt: new Date(),
      },
      {
        lessonId: lesson1Result.insertedId,
        title: "HTML: Image: Display online image, local image, folder image",
        content: {
          description:
            "Display images from different sources: online URLs, local files, and folder structures.",
          contentBlocks: [
            {
              type: "code",
              language: "html",
              code: "<img src='https://example.com/image.jpg' alt='Online image'>\n<img src='images/photo.png' alt='Local image'>",
              caption: "Image examples",
            },
            {
              type: "note",
              variant: "warning",
              title: "Always use alt text",
              content:
                "The alt attribute is important for accessibility and SEO.",
            },
          ],
          duration: "12 minutes",
          readingTime: "6 minutes",
        },
        order: 6,
        createdAt: new Date(),
      },
      {
        lessonId: lesson1Result.insertedId,
        title: "HTML: Form: Input types, buttons, select, options, login form",
        content: {
          description:
            "Create forms with various input types, buttons, select dropdowns, and build a login form.",
          contentBlocks: [
            {
              type: "code",
              language: "html",
              code: "<form>\n  <input type='text' placeholder='Username'>\n  <input type='password' placeholder='Password'>\n  <select>\n    <option>Option 1</option>\n    <option>Option 2</option>\n  </select>\n  <button type='submit'>Login</button>\n</form>",
              caption: "Form elements",
            },
            {
              type: "component",
              component: "FormDemo",
              props: {},
            },
          ],
          duration: "20 minutes",
          readingTime: "10 minutes",
        },
        order: 7,
        createdAt: new Date(),
      },
      {
        lessonId: lesson1Result.insertedId,
        title: "HTML: Structure: Directory, html, head, meta, title, body",
        content: {
          description:
            "Understand the complete HTML document structure including DOCTYPE, html, head, meta, title, and body.",
          contentBlocks: [
            {
              type: "code",
              language: "html",
              code: "<!DOCTYPE html>\n<html lang='en'>\n<head>\n  <meta charset='UTF-8'>\n  <meta name='viewport' content='width=device-width, initial-scale=1.0'>\n  <title>Document Title</title>\n</head>\n<body>\n  <h1>Page Content</h1>\n</body>\n</html>",
              caption: "Complete HTML document structure",
            },
          ],
          duration: "10 minutes",
          readingTime: "5 minutes",
        },
        order: 8,
        createdAt: new Date(),
      },
      {
        lessonId: lesson1Result.insertedId,
        title: "HTML: Overview: Basic HTML concepts and practice task",
        content: {
          description:
            "Review all HTML concepts learned and complete a practice task to build your first webpage.",
          contentBlocks: [
            {
              type: "text",
              content:
                "Congratulations! You've learned the basics of HTML. Now it's time to practice.",
              style: "heading",
            },
            {
              type: "list",
              items: [
                "Create a new HTML file",
                "Add a title",
                "Create headings and paragraphs",
                "Add a list",
                "Insert an image",
                "Create a link",
                "Build a simple form",
              ],
              ordered: true,
            },
            {
              type: "note",
              variant: "success",
              title: "Practice Task",
              content:
                "Build a personal introduction page with all the elements you've learned!",
            },
          ],
          duration: "25 minutes",
          readingTime: "12 minutes",
        },
        order: 9,
        createdAt: new Date(),
      },
    ];

    // Insert the 9 topics
    if (topics.length > 0) {
      const topicsResult = await topicCollection.insertMany(topics);
      console.log(
        `    ✅ Created ${topicsResult.insertedCount} basic topics for lesson`,
      );
    }

    // ============= RICH TOPIC WITH ALL CONTENT TYPES =============
    const richTopic = {
      lessonId: lesson1Result.insertedId,
      title: "HTML: Complete Introduction with Examples (Demo)",
      order: 10,
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
    console.log(`    ✅ Created rich demo topic: ${richTopic.title}`);

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

    // Add lessons for Chapter 2
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
    console.log(`Course ID: ${course._id}`);

    const totalChapters = await chapterCollection.countDocuments({
      courseId: course._id,
    });
    const totalLessons = await lessonCollection.countDocuments({});
    const totalTopics = await topicCollection.countDocuments({});

    console.log(`Total chapters: ${totalChapters}`);
    console.log(`Total lessons: ${totalLessons}`);
    console.log(`Total topics: ${totalTopics}`);
    console.log(`- Lesson 1 has 10 topics (9 basic + 1 demo)`);

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
