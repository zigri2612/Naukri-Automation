const fs = require("fs");
const path = require("path");
const os = require("os");
const { localStorage } = require("./helper");

const TEMP_DIR = path.join(os.tmpdir(), 'naukri-ninja');

/**
 * Load answers from a user-supplied questions.json file (batch mode).
 * The file should be a JSON object keyed by question name (or questionName).
 * Example structure:
 * {
 *   "noticePeriod": "1 month",
 *   "are you available to join immediately?": "No",
 *   "total years of experience": "5"
 * }
 */
const loadQuestionBank = async () => {
  const profile = await localStorage.getItem("profile");
  const profileId = profile?.id || "default";

  // 1. Check for a questions.json in the project data folder or profile folder
  // 2. Check for a questions.json in the root of the application
  // 3. Check for questions.json in the user's Documents folder
  const possiblePaths = [
    path.join(process.cwd(), "questions.json"),
    path.join(TEMP_DIR, `/data/${profileId}/questions.json`),
    path.join(os.homedir(), "Documents", "questions.json"),
    path.join(TEMP_DIR, "questions.json"),
  ];

  for (const filePath of possiblePaths) {
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, "utf8");
        const bank = JSON.parse(raw);
        if (bank && typeof bank === "object") {
          return bank;
        }
      }
    } catch (error) {
      console.debug(`Failed to load question bank from ${filePath}:`, error.message);
    }
  }

  // Fallback: check the saved questions file for this profile
  const savedQuestions = await getSavedQuestionAnswers(profileId);
  return savedQuestions;
};

/**
 * Retrieve saved answers from the per-profile questions cache file.
 * This is the file that handleQuestionnaire normally writes.
 */
const getSavedQuestionAnswers = async (profileId) => {
  const possiblePaths = [
    path.join(TEMP_DIR, `/data/${profileId}/questions.json`),
    path.join(TEMP_DIR, "questions.json"),
  ];

  for (const filePath of possiblePaths) {
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, "utf8");
        const data = JSON.parse(raw);
        if (data && typeof data === "object") return data;
      }
    } catch (error) {
      // Silently continue
    }
  }

  return null;
};

/**
 * Lookup an answer from the question bank for a given question text.
 * Performs a case-insensitive substring match.
 */
const findAnswerFromBank = (questionBank, questionName) => {
  if (!questionBank || typeof questionBank !== "object") return null;

  const qLower = (questionName || "").toLowerCase().trim();

  // Exact key match
  for (const key of Object.keys(questionBank)) {
    if (key.toLowerCase().trim() === qLower) {
      return questionBank[key];
    }
  }

  // Substring match (key contains question text or vice versa)
  for (const key of Object.keys(questionBank)) {
    const keyLower = key.toLowerCase().trim();
    if (keyLower.includes(qLower) || qLower.includes(keyLower)) {
      const entry = questionBank[key];
      if (typeof entry === "object" && entry !== null) {
        return entry.answer !== undefined ? entry.answer : entry;
      }
      return entry;
    }
  }

  return null;
};

/**
 * Generate fallback answers for unanswered questionnaire questions in batch mode.
 * Uses default answers based on question type and common patterns.
 */
const generateFallbackAnswers = (questions) => {
  const answers = {};

  for (const q of questions) {
    const questionName = q.questionName || "";
    const qLower = questionName.toLowerCase();

    // Try to infer answer from question text
    let fallback = "";

    if (qLower.includes("notice period") || qLower.includes("notice")) {
      fallback = "0";
    } else if (
      qLower.includes("experience") ||
      qLower.includes("year") ||
      qLower.includes("years")
    ) {
      fallback = "0";
    } else if (qLower.includes("salary") || qLower.includes("ctc") || qLower.includes("current")) {
      fallback = "0";
    } else if (
      qLower.includes("available") ||
      qLower.includes("join") ||
      qLower.includes("immediate")
    ) {
      fallback = "Yes";
    } else if (
      qLower.includes("relocate") ||
      qLower.includes("willing to travel")
    ) {
      fallback = "Yes";
    } else if (q.questionType === "Text Box") {
      fallback = "NA";
    } else if (
      ["List Menu", "Radio Button"].includes(q.questionType) &&
      q.answerOption &&
      Object.keys(q.answerOption).length > 0
    ) {
      fallback = Object.values(q.answerOption)[0];
    } else if (q.questionType === "Check Box") {
      fallback = [];
    } else {
      fallback = "NA";
    }

    answers[q.questionId] = fallback;
  }

  return answers;
};

module.exports = {
  loadQuestionBank,
  findAnswerFromBank,
  generateFallbackAnswers,
};
