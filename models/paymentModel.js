// backend/models/paymentModel.js
// Add this to your database collections
const paymentCollection = db.collection("payments");

// Create indexes
await paymentCollection.createIndex({ paymentID: 1 }, { unique: true });
await paymentCollection.createIndex({ orderId: 1 });
await paymentCollection.createIndex({ userId: 1 });
await paymentCollection.createIndex({ status: 1 });
await paymentCollection.createIndex({ createdAt: -1 });

// Payment document structure
const paymentSchema = {
  paymentID: "TR0011kMH7LtQ1731358567158", // bKash payment ID
  orderId: "ORDER-123456", // Your internal order ID
  userId: ObjectId, // Student's user ID
  courseId: ObjectId, // Course being purchased
  amount: 1000,
  currency: "BDT",
  status: "Initiated", // Initiated, Completed, Failed, Cancelled
  trxID: "BK0001XX2ZY", // bKash transaction ID (after success)
  merchantInvoiceNumber: "INV-123456",
  payerReference: "Customer123",
  paymentCreateTime: new Date(),
  paymentExecuteTime: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};
