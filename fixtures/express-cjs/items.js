const express = require("express");

const router = express.Router();

function listItems() {}
function createItem() {}

router.get("/", listItems);
router.post("/", createItem);

module.exports = router;
