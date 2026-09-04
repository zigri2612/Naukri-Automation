#!/usr/bin/env node
/**
 * Batch mode entry point for Naukri Automation.
 * Processes all profiles sequentially: search jobs, apply, answer questionnaires
 * using questions.json, send emails to recruiters.
 */
process.env.NAUKRI_BATCH_MODE = "1";
process.env.NODE_NO_WARNINGS = "1";

// Disable interactive readline prompts — batch mode runs without user input
require("./index.js");
