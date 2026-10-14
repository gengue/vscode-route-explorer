const express = require("express");
const items = require("./items");

const app = express();

function health() {}

app.use("/items", items);
app.get("/health", health);

module.exports = app;
