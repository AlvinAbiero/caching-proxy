#!/usr/bin/env node

const express = require("express");
const axios = require("axios");
const yargs = require("yargs");
const NodeCache = require("node-cache");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

class CachingProxy {
  constructor() {
    this.app = express();
    this.cache = new NodeCache({ stdTTL: 3600 }); // Default 1-hour cache
    this.cacheFilePath = path.join(
      process.env.HOME || process.env.USERPROFILE,
      ".caching-proxy-cache.json"
    );
  }

  // Generate a unique cache key based on request details
  generateCacheKey(req) {
    const keyData = {
      method: req.method,
      url: req.url,
      headers: req.headers,
    };
    return crypto
      .createHash("md5")
      .update(JSON.stringify(keyData))
      .digest("hex");
  }

  // Save cache to persistent storage
  saveCache() {
    const cacheData = this.cache.keys().reduce((acc, key) => {
      acc[key] = this.cache.get(key);
      return acc;
    }, {});
    fs.writeFileSync(this.cacheFilePath, JSON.stringify(cacheData), "utf8");
  }

  // load cache from persistent storage
  loadCache() {
    try {
      if (fs.existsSync(this.cacheFilePath)) {
        const cacheData = JSON.parse(
          fs.readFileSync(this.cacheFilePath, "utf8")
        );
        Object.entries(cacheData).forEach(([key, value]) => {
          this.cache.set(key, value);
        });
      }
    } catch (error) {
      console.error("Error loading cache:", error);
    }
  }

  // clear the entire cache
  clearCache() {
    this.cache.flushAll();
    if (fs.existsSync(this.cacheFilePath)) {
      fs.unlinkSync(this.cacheFilePath);
    }
    console.log("Cache cleared successfully.");
  }

  // Start the caching proxy server
  start(port, origin) {
    this.loadCache();

    this.app.on("error", (error) => {
      if (error.code === "EADDRINUSE") {
        console.error(
          `Port ${port} is already in use. Please try a different port.`
        );
        process.exit(1);
      }
    });

    this.app.use(async (req, res) => {
      const cacheKey = this.generateCacheKey(req);
      const cachedResponse = this.cache.get(cacheKey);

      if (cachedResponse) {
        res.set("X-Cache", "HIT");
        return res.json(cachedResponse);
      }

      try {
        // Remove problematic headers that might cause 304 responses
        const headers = { ...req.headers };
        delete headers["if-none-match"];
        delete headers["if-modified-since"];

        // Add axios configuration to handle SSL/TLS issues
        const response = await axios({
          method: req.method,
          url: `${origin}${req.url}`,
          headers: {
            ...req.headers,
            host: new URL(origin).host, // Ensure correct host header
          },
          httpsAgent: new (require("https").Agent)({
            rejectUnauthorized: false, // Only use in development!
            secureProtocol: "TLSv1_2_method",
            servername: new URL(origin).hostname,
          }),
          // Add validateStatus to accept 304 as valid
          validateStatus: function (status) {
            return (status >= 200 && status < 300) || status === 304;
          },
        });

        // Handle both 200 and 304 responses
        if (response.status === 304 && cachedResponse) {
          res.set("X-Cache", "HIT");
          return res.json(cachedResponse);
        }

        // Only cache and return data for successful responses with data
        if (response.data) {
          res.set("X-Cache", "MISS");
          this.cache.set(cacheKey, response.data);
          await this.saveCache();
          return res.json(response.data);
        }

        // Handle case where we got a 304 but no cache
        if (response.status === 304 && !cachedResponse) {
          // Make a new request without cache headers
          const freshResponse = await axios({
            method: req.method,
            url: `${origin}${req.url}`,
            headers: {
              ...headers,
              host: new URL(origin).host,
            },
            httpsAgent: new (require("https").Agent)({
              rejectUnauthorized: false,
              secureProtocol: "TLSv1_2_method",
              servername: new URL(origin).hostname,
            }),
          });

          res.set("X-Cache", "MISS");
          this.cache.set(cacheKey, freshResponse.data);
          await this.saveCache();
          return res.json(freshResponse.data);
        }
      } catch (error) {
        console.error("Proxy error:", error);

        // Handle specific error cases
        if (error.response?.status === 304) {
          if (cachedResponse) {
            res.set("X-Cache", "HIT");
            return res.json(cachedResponse);
          }
        }

        res.status(error.response?.status || 500).json({
          error: "Proxy request failed",
          details: error.message,
        });
      }
    });

    this.app.listen(port, () => {
      console.log(
        `Caching proxy server running on port ${port}, proxying to ${origin}`
      );
    });
  }
}

// CLI Configurations
const argv = yargs
  .usage("Usage: catching-proxy [options]")
  .option("port", {
    alias: "p",
    describe: "Port number for the proxy server",
    type: "Number",
    default: 3000,
  })
  .option("origin", {
    alias: "o",
    describe: "Origin server URL",
    type: "string",
    demandOption: true,
  })
  .option("clear-cache", {
    alias: "c",
    describe: "Clear the entire cache",
    type: "boolean",
    default: false,
  })
  .option("ttl", {
    alias: "t",
    describe: "Cache TTL (time-to-live) in seconds",
    type: "number",
    default: 60,
  })
  .help("help")
  .alias("help", "h").argv;

const proxy = new CachingProxy();

if (argv["clear-cache"]) {
  proxy.clearCache();
} else {
  proxy.start(argv.port, argv.origin);
}

module.exports = CachingProxy;
