// backend/services/bkashService.js
const axios = require("axios");

class BkashService {
  constructor() {
    this.baseURL = process.env.BKASH_BASE_URL;
    this.appKey = process.env.BKASH_APP_KEY;
    this.appSecret = process.env.BKASH_APP_SECRET;
    this.username = process.env.BKASH_USERNAME;
    this.password = process.env.BKASH_PASSWORD;
    this.frontendURL = process.env.BKASH_FRONTEND_URL;
    this.token = null;
    this.tokenExpiry = null;
  }

  // Generate grant token
  async getToken() {
    try {
      // Check if token is still valid
      if (this.token && this.tokenExpiry > Date.now()) {
        return this.token;
      }

      const response = await axios.post(
        `${this.baseURL}/tokenized/checkout/token/grant`,
        {
          app_key: this.appKey,
          app_secret: this.appSecret,
        },
        {
          headers: {
            "Content-Type": "application/json",
            username: this.username,
            password: this.password,
          },
        },
      );

      if (response.data.statusCode === "0000") {
        this.token = response.data.id_token;
        this.tokenExpiry = Date.now() + response.data.expires_in * 1000 - 60000; // Subtract 1 minute buffer
        return this.token;
      } else {
        throw new Error(response.data.statusMessage || "Failed to get token");
      }
    } catch (error) {
      console.error(
        "bKash token error:",
        error.response?.data || error.message,
      );
      throw error;
    }
  }

  // Refresh token
  async refreshToken(refreshToken) {
    try {
      const response = await axios.post(
        `${this.baseURL}/tokenized/checkout/token/refresh`,
        {
          app_key: this.appKey,
          app_secret: this.appSecret,
          refresh_token: refreshToken,
        },
        {
          headers: {
            "Content-Type": "application/json",
            username: this.username,
            password: this.password,
          },
        },
      );

      return response.data;
    } catch (error) {
      console.error(
        "bKash refresh token error:",
        error.response?.data || error.message,
      );
      throw error;
    }
  }

  // Create payment
  async createPayment(amount, orderId, payerReference) {
    try {
      const token = await this.getToken();
      const invoiceNumber = `INV-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

      const response = await axios.post(
        `${this.baseURL}/tokenized/checkout/create`,
        {
          mode: "0011", // Checkout mode
          payerReference: payerReference || "01",
          callbackURL: `${this.frontendURL}/payment/callback`,
          amount: amount.toString(),
          currency: "BDT",
          intent: "sale",
          merchantInvoiceNumber: invoiceNumber,
        },
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: token,
            "X-APP-Key": this.appKey,
          },
        },
      );

      if (response.data.statusCode === "0000") {
        return {
          success: true,
          paymentID: response.data.paymentID,
          bkashURL: response.data.bkashURL,
          invoiceNumber,
          amount: response.data.amount,
        };
      } else {
        throw new Error(
          response.data.statusMessage || "Failed to create payment",
        );
      }
    } catch (error) {
      console.error(
        "bKash create payment error:",
        error.response?.data || error.message,
      );
      throw error;
    }
  }

  // Execute payment
  async executePayment(paymentID) {
    try {
      const token = await this.getToken();

      const response = await axios.post(
        `${this.baseURL}/tokenized/checkout/execute`,
        {
          paymentID,
        },
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: token,
            "X-APP-Key": this.appKey,
          },
        },
      );

      if (response.data.statusCode === "0000") {
        return {
          success: true,
          trxID: response.data.trxID,
          paymentID: response.data.paymentID,
          amount: response.data.amount,
          merchantInvoiceNumber: response.data.merchantInvoiceNumber,
          paymentExecuteTime: response.data.paymentExecuteTime,
        };
      } else {
        throw new Error(
          response.data.statusMessage || "Failed to execute payment",
        );
      }
    } catch (error) {
      console.error(
        "bKash execute payment error:",
        error.response?.data || error.message,
      );
      throw error;
    }
  }

  // Query payment status
  async queryPayment(paymentID) {
    try {
      const token = await this.getToken();

      const response = await axios.post(
        `${this.baseURL}/tokenized/checkout/payment/status`,
        {
          paymentID,
        },
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: token,
            "X-APP-Key": this.appKey,
          },
        },
      );

      return response.data;
    } catch (error) {
      console.error(
        "bKash query payment error:",
        error.response?.data || error.message,
      );
      throw error;
    }
  }
}

module.exports = new BkashService();
