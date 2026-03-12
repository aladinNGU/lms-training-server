// backend/update-users-status.js
const { MongoClient } = require("mongodb");
require("dotenv").config();

async function updateUsersStatus() {
  const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.zn6isea.mongodb.net/?appName=Cluster0`;
  const client = new MongoClient(uri);

  try {
    await client.connect();
    console.log("✅ Connected to MongoDB");

    const db = client.db("lmsDB");
    const userCollection = db.collection("users");

    // Check users before update
    const usersWithoutStatus = await userCollection.countDocuments({
      status: { $exists: false },
    });

    console.log(`📊 Found ${usersWithoutStatus} users without status field`);

    if (usersWithoutStatus > 0) {
      // Update users missing status field
      const result = await userCollection.updateMany(
        { status: { $exists: false } },
        { $set: { status: "active" } },
      );

      console.log(
        `✅ Updated ${result.modifiedCount} users with default 'active' status`,
      );
    } else {
      console.log("✅ All users already have status field");
    }

    // Show current status distribution
    const statusStats = await userCollection
      .aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }])
      .toArray();

    console.log("\n📊 Current status distribution:");
    statusStats.forEach((stat) => {
      console.log(`   ${stat._id || "undefined"}: ${stat.count} users`);
    });

    // Show current role distribution
    const roleStats = await userCollection
      .aggregate([{ $group: { _id: "$role", count: { $sum: 1 } } }])
      .toArray();

    console.log("\n📊 Current role distribution:");
    roleStats.forEach((stat) => {
      console.log(`   ${stat._id || "undefined"}: ${stat.count} users`);
    });
  } catch (error) {
    console.error("❌ Error:", error);
  } finally {
    await client.close();
    console.log("\n👋 MongoDB connection closed");
  }
}

updateUsersStatus();
