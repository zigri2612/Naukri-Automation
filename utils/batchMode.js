const { getFileData, getDataFromFile, getResumePath } = require("./ioUtils");
const { login, getUserProfile } = require("./userUtils");
const { localStorage } = require("./helper");
const {
  findNewJobs,
  applyForJobs,
  handleQuestionnaire,
  getResume,
} = require("./jobUtils");
const {
  writeToFile,
  matchingStrategy,
} = require("./utils");
const { sendEmails } = require("./emailUtils");
const spinner = require("./spinniesUtils");
const analyticsManager = require("./analyticsUtils");
const { incrementCounterAPI } = require("../api");

/**
 * Load all saved profiles from storage
 */
const loadAllProfiles = async () => {
  const profiles = await getFileData("profiles");
  if (!profiles || profiles.length === 0) {
    console.log("No profiles found. Please add profiles first.");
    return [];
  }
  return profiles;
};

/**
 * Process a single profile: login, search jobs, apply, answer questionnaires, send emails
 */
const processProfile = async (profile, preferences) => {
  console.clear();
  console.log(`\n=== Processing profile: ${profile.id} ===\n`);

  try {
    // --- Login ---
    spinner.start("Logging in...");
    const loginInfo = await login(profile);
    localStorage.setItem("authorization", loginInfo.authorization);

    // --- Fetch user profile ---
    const user = await getUserProfile();
    localStorage.setItem("profile", user);
    localStorage.setItem("preferences", preferences);
    analyticsManager.loadStats();

    spinner.succeed(`Logged in as ${user.userDetails.name}`);

    // --- Search for new jobs ---
    const { noOfPages, dailyQuota } = preferences;
    const jobIds = await findNewJobs(noOfPages);

    if (!jobIds || jobIds.length === 0) {
      console.log("No new jobs found for this profile.");
      return { applied: 0, sent: 0, profile: profile.id };
    }

    // --- Apply for jobs ---
    let jobCount = 0;
    const startTime = Date.now();

    for (let i = 0; i < jobIds.length; i++) {
      try {
        const job = jobIds[i];
        const isAlreadyApplied = job.isApplied;
        const isSuitable = job.isSuitable || (await matchingStrategy(job, user));
        job.isSuitable = isSuitable;

        if (!isSuitable || isAlreadyApplied) {
          console.debug(
            `> ${i + 1} of ${jobIds.length} | ${job.jobTitle} in ${
              job.companyName
            } | ${isAlreadyApplied ? "Already applied" : "not suitable"}`
          );
          continue;
        }

        console.log(
          `> ${i + 1} of ${jobIds.length} | ${job.jobTitle} in ${
            job.companyName
          } | Suitable — applying...`
        );

        const jobsSlot = [job];
        const result = await applyForJobs(jobsSlot);

        if (!result || !result.jobs) {
          console.log("Application skipped or already applied.");
          continue;
        }

        if (result.jobs[0].status == 200) {
          spinner.stop();
          console.log(
            `Applied successfully | ${job.jobTitle} | Quota: ${result.quotaDetails.dailyApplied}`
          );
          jobCount++;
          incrementCounterAPI();
          analyticsManager.incrementJobsApplied();
          jobIds[i].isApplied = true;

          if (result.quotaDetails.dailyApplied >= dailyQuota) {
            spinner.fail("Daily quota reached for this profile.");
            break;
          }
          continue;
        }

        // --- Handle questionnaire ---
        if (
          result.jobs[0].status !== 200 &&
          (preferences.enableManualAnswering || preferences.enableGenAi)
        ) {
          const questionnaire = await handleQuestionnaire(
            result,
            preferences.enableGenAi
          );

          if (questionnaire) {
            const finalResult = await applyForJobs(jobsSlot, questionnaire);
            if (finalResult && finalResult.jobs[0].status == 200) {
              spinner.stop();
              console.log(
                `Applied successfully | ${job.jobTitle} | Quota: ${finalResult.quotaDetails.dailyApplied}`
              );
              jobCount++;
              incrementCounterAPI();
              analyticsManager.incrementJobsApplied();
              jobIds[i].isApplied = true;

              if (finalResult.quotaDetails.dailyApplied >= dailyQuota) {
                spinner.fail("Daily quota reached for this profile.");
                break;
              }
            }
          }
        }
      } catch (e) {
        if (e.message == "409001") {
          spinner.fail(e.message);
        } else if (e.message == "403") {
          console.log("⚠️  403 Forbidden — Naukri is blocking requests. Stopping job applications for this profile.");
          console.log("    Proceeding to send emails with already-collected HR contacts...");
          break; // Stop applying jobs but continue to email sending
        } else if (e.message == "401") {
          // Re-login and retry
          await login(profile);
          i--;
          continue;
        } else {
          console.log(e.message);
        }
      } finally {
        writeToFile(jobIds, "filteredJobIds", profile.id);
      }
    }

    const endTime = Date.now();
    const timeTaken = (endTime - startTime) / 1000;
    console.log(
      `\nProfile ${profile.id}: Applied for ${jobCount} jobs in ${timeTaken.toFixed(
        1
      )} seconds`
    );

    // --- Send emails to recruiters ---
    const sentCount = await processEmailsForProfile(profile.id, user);

    return { applied: jobCount, sent: sentCount, profile: profile.id };
  } catch (error) {
    console.error(`Error processing profile ${profile.id}:`, error.message);
    return { applied: 0, sent: 0, profile: profile.id, error: error.message };
  }
};

/**
 * Send emails to recruiters for the given profile using saved HR emails
 */
const processEmailsForProfile = async (profileId, user) => {
  try {
    const recipients = await getDataFromFile("hrEmails", profileId);
    if (!recipients || recipients.length === 0) {
      console.log("No HR emails found to send.");
      return 0;
    }

    const newEmails = recipients.filter((e) => !e.mailSent);
    if (newEmails.length === 0) {
      console.log("All HR emails already sent.");
      return 0;
    }

    console.log(`Sending ${newEmails.length} emails to recruiters...`);

    // Get mail password from preferences
    const preferences = await getDataFromFile("preferences", profileId);
    if (!preferences?.mailPassword) {
      console.log("Mail password not found. Skipping email sending.");
      return 0;
    }

    // Get resume and template
    const filename = await getResume();
    const resumePath = await getResumePath(filename);
    if (!resumePath) {
      console.log("Resume not found. Skipping email sending.");
      return 0;
    }

    // Build email template
    const { emailTemplate } = require("./emailTemplate");
    const linkedInProfile =
      user.onlineProfile.find((p) => p.type === "LinkedIn")?.url || "";
    const template = emailTemplate(
      user.userDetails.name,
      user.userDetails.mobile,
      linkedInProfile,
      user.profile.totalExperience,
      user.skills,
      user.workSamples
    );

    await sendEmails(
      newEmails,
      preferences.mailPassword,
      template,
      resumePath
    );

    console.log(`Emails sent successfully.`);
    return newEmails.length;
  } catch (error) {
    console.error("Error sending emails:", error.message);
    return 0;
  }
};

/**
 * Run batch mode: process all profiles sequentially
 */
const runBatchMode = async () => {
  console.clear();
  console.log("🚀 Starting Naukri Automation in BATCH MODE\n");

  const profiles = await loadAllProfiles();
  if (profiles.length === 0) {
    console.log("No profiles available. Exiting batch mode.");
    return;
  }

  console.log(`Found ${profiles.length} profile(s). Processing...\n`);

  const results = [];
  for (let i = 0; i < profiles.length; i++) {
    const profile = profiles[i];
    console.log(
      `\n--- Profile ${i + 1}/${profiles.length}: ${profile.id} ---\n`
    );

    try {
      // Get or create preferences for this profile
      let preferences = await getDataFromFile("preferences", profile.id);
      if (!preferences) {
        // First, login to get the user profile so we can derive preferences
        const loginInfo = await login(profile);
        localStorage.setItem("authorization", loginInfo.authorization);
        const user = await getUserProfile();
        // Use defaults since we can't interactively configure in batch mode
        preferences = {
          noOfPages: 5,
          dailyQuota: 40,
          desiredRole: user.profile.desiredRole,
          keywords: user.profile.keySkills
            ? user.profile.keySkills.split(",").map((s) => s.trim())
            : ["Software", "Developer"],
          matchStrategy: "naukriMatching",
          enableGenAi: true, // Enable GenAI for questionnaire answers
          enableManualAnswering: false,
          genAiModel: "gemini",
          genAiConfig: { authType: "apiKey" },
        };
        writeToFile(preferences, "preferences", profile.id);
      }

      const result = await processProfile(profile, preferences);
      results.push(result);

      // Small delay between profiles
      if (i < profiles.length - 1) {
        console.log("\nWaiting 5 seconds before next profile...");
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    } catch (error) {
      console.error(`Failed to process profile ${profile.id}:`, error.message);
      results.push({
        applied: 0,
        sent: 0,
        profile: profile.id,
        error: error.message,
      });
    }
  }

  // Print summary
  console.clear();
  console.log("📊 BATCH MODE COMPLETE — Summary\n");
  console.log("=========================================");
  let totalApplied = 0;
  let totalSent = 0;
  for (const result of results) {
    const status = result.error ? "❌ FAILED" : "✅ SUCCESS";
    console.log(
      `${status} | Profile: ${result.profile} | Jobs Applied: ${result.applied} | Emails Sent: ${result.sent}${
        result.error ? ` | Error: ${result.error}` : ""
      }`
    );
    totalApplied += result.applied || 0;
    totalSent += result.sent || 0;
  }
  console.log("=========================================");
  console.log(`Total: ${totalApplied} jobs applied, ${totalSent} emails sent\n`);

  process.exit(0);
};

module.exports = {
  runBatchMode,
  processProfile,
  loadAllProfiles,
};
