#!/usr/bin/env node
process.env.NODE_NO_WARNINGS = "1";

const {
  writeToFile,
  matchingStrategy,
  writeFileData,
  getFileData,
} = require("./utils/utils");
const { rl, askQuestion, getDataFromFile, streamText, getResumePath } = require("./utils/ioUtils");
const {
  selectProfile,
  login,
  getUserProfile,
  manageProfiles,
  getPreferences,
  resetAccount,
} = require("./utils/userUtils");
const {
  getExistingJobs,
  findNewJobs,
  applyForJobs,
  handleQuestionnaire,
  getResume,
} = require("./utils/jobUtils");
const {
  recordJobApplication,
} = require("./utils/appliedJobsUtils");
const prompts = require("@inquirer/prompts");
const { localStorage } = require("./utils/helper");
const { incrementCounterAPI } = require("./api");
const {
  handleEmailsMenu,
  sendEmails,
  getEmails,
  editEmailTemplate,
} = require("./utils/emailUtils");
const {
  autoUpdate,
  restartProgram,
} = require("./utils/programUtils");
const { showMainMenu } = require("./utils/prompts");
const spinner = require("./utils/spinniesUtils");
const analyticsManager = require('./utils/analyticsUtils');
const { getUnusedPhrase } = require("./constants/funPhrases");
const { getAuthorInfo } = require("./utils/about");
const { checkForUpdates } = require("./utils/updater");
const repetitions = 1;

const isDebugMode = process.execArgv.includes("--inspect");

if (!isDebugMode) {
  console.debug = () => {}; // Disable console.debug in production mode
}

const doTheStuff = async (profile, preferences, useExistingJobs = false, maxApplications = 50) => {
  //console.clear();
  const { noOfPages, dailyQuota } = preferences;
  let jobIds = [];
  let jobCount = 0;
  try {
    console.log(`Mission Job search Started for profile: ${profile.id}...`);
    const startTime = Date.now();
    // const ans = await jobSearchMenu();
    if (useExistingJobs) {
      jobIds = await getExistingJobs();
    }

    if (!useExistingJobs || jobIds.length === 0) {
      jobIds = await findNewJobs(noOfPages, repetitions);
    }
    for (let i = 0; i < jobIds.length; i++) {
      try {
        const job = jobIds[i];
        const isAlreadyApplied = job.isApplied;
        const isSuitable =
          job.isSuitable || (await matchingStrategy(job, profile));
        job.isSuitable = isSuitable;

        if (!isSuitable || isAlreadyApplied) {
          console.debug(
            `> ${i + 1} of ${jobIds.length} | ${job.jobTitle} in ${
              job.companyName
            } | ${isAlreadyApplied ? "Already applied" : "not suitable"}`
          );
          console.debug("\n");
          continue;
        }

        console.log(
          `> ${i + 1} of ${jobIds.length} | ${job.jobTitle} in ${
            job.companyName
          } | ${isSuitable ? "Suitable" : "Not Suitable"} [${jobCount + 1}/${maxApplications}]`
        );

        const jobsSlot = [job];
        const result = await applyForJobs(jobsSlot);

        if (!result) {
          console.log("result undefined");
          continue;
        }
        if (!result.jobs) {
          throw new Error("409001");
        }
        if (result.jobs[0].status == 200) {
          spinner.stop();
          console.log(
            `Applied successfully | ${job.jobTitle} | Quota: ${result.quotaDetails.dailyApplied}`
          );
          // Record the application in applied jobs tracking
          try {
            await recordJobApplication(job, profile.id);
          } catch (recordError) {
            console.error("Failed to record application locally (job applied on Naukri):", recordError.message);
          }
          // Increment counters regardless of local recording (application succeeded on Naukri)
          jobCount++;
          incrementCounterAPI();
          analyticsManager.incrementJobsApplied();
          if (result.quotaDetails.dailyApplied >= dailyQuota) {
            spinner.fail("Daily quota reached");
            break;
          }
          jobIds[i].isApplied = true;
        }
        if (
          result.jobs[0].status !== 200 &&
          (!preferences.enableManualAnswering && !preferences.enableGenAi)
        ) {
          console.log("Skipping job as manual & genAI answering is disabled");
          continue;
        }
        if (
          result.jobs[0].status !== 200 &&
          (preferences.enableManualAnswering || preferences.enableGenAi)
        ) {
          const questionnaire = await handleQuestionnaire(
            result,
            preferences.enableGenAi
          );
          const finalResult = await applyForJobs(jobsSlot, questionnaire);
          if (finalResult.jobs[0].status == 200) {
            spinner.stop();
            console.log(
              `Applied successfully | Quota: ${finalResult.quotaDetails.dailyApplied}`
            );
            // Record the application in applied jobs tracking
            try {
              await recordJobApplication(job, profile.id);
            } catch (recordError) {
              console.error("Failed to record application locally (job applied on Naukri):", recordError.message);
            }
            // Increment counters regardless of local recording (application succeeded on Naukri)
            jobCount++;
            incrementCounterAPI();
            analyticsManager.incrementJobsApplied();
            jobIds[i].isApplied = true;
          }
        }
      } catch (e) {
        if (e.message == 200 || e.message == 409001) {
          spinner.fail(e.message);
        } else if (e.message == 403) {
          throw new Error(e);
        } else if (e.message == 401) {
          await login();
          i--;
          continue;
        } else {
          if(spinner.spinner){
            spinner.fail(e.message);
          }else{
            console.log(e.message);
          }
        }
      }
    }
    const endTime = Date.now();
    const timeTaken = (endTime - startTime) / 1000;
    console.log(`Profile ${profile.id}: Applied for ${jobCount} jobs in ${timeTaken.toFixed(1)} seconds`);
  } catch (e) {
    console.log(isDebugMode ? e : e.message);
  } finally {
    spinner.stop();
    writeToFile(jobIds, "filteredJobIds", profile.id);
  }
  return jobCount;
};

// Process all profiles sequentially - apply up to dailyQuota from each profile's preferences
const processAllProfiles = async (profiles, preferences, useExistingJobs = false) => {
  console.clear();
  console.log(`\n=== Multi-Profile Job Application ===`);
  console.log(`Profiles to process: ${profiles.length}`);
  console.log(`=====================================\n`);

  const results = [];
  let totalApplied = 0;

  for (let i = 0; i < profiles.length; i++) {
    const profile = profiles[i];
    console.log(`\n[${i + 1}/${profiles.length}] Processing profile: ${profile.id}`);

    try {
      // Login for this profile
      const loginInfo = await login(profile);
      const authorization = loginInfo.authorization;
      localStorage.setItem("authorization", authorization);

      // Get user profile
      const user = await getUserProfile();
      localStorage.setItem("profile", user);

      // Update profiles list with new login info
      const updatedProfiles = await manageProfiles(user, loginInfo);
      writeFileData(updatedProfiles, "profiles");

      analyticsManager.loadStats();

      // Load preferences for this profile (or use global)
      let profilePreferences = await getDataFromFile("preferences", user.id);
      if (!profilePreferences) {
        profilePreferences = preferences || { noOfPages: 5, dailyQuota: 50 }; // Default fallback if both are null
      }
      localStorage.setItem("preferences", profilePreferences);

      // Apply jobs for this profile
      const appliedCount = await doTheStuff(user, profilePreferences, useExistingJobs, profilePreferences?.dailyQuota);
      results.push({ profile: profile.id, applied: appliedCount });
      totalApplied += appliedCount;

      console.log(`\n--- Profile ${profile.id} complete: ${appliedCount} jobs applied ---`);

      // Send HR emails after job processing (regardless of success/failure)
      try {
        let mailPassword = profilePreferences?.mailPassword;

        if (mailPassword) {
          const resumeFilename = await getResume();
          let resumePath = await getResumePath(resumeFilename);
          let emailTemplate = await editEmailTemplate(true); // auto-skip prompt, use existing or default template

          const recipients = await getEmails();
          if (recipients && recipients.length > 0) {
            try {
              await sendEmails(recipients, mailPassword, emailTemplate, resumePath);
            } catch (sendError) {
              console.log(`Failed to send HR emails for profile ${profile.id}:`, sendError.message);
            }
          } else {
            console.log(`No HR emails to send for profile ${profile.id}`);
          }
        }
      } catch (emailError) {
        console.error(`Error in email processing for profile ${profile.id}:`, emailError.message);
      }

      // Small delay between profiles to avoid rate limiting
      if (i < profiles.length - 1) {
        console.log("Waiting 3 seconds before next profile...");
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    } catch (error) {
      console.error(`Error processing profile ${profile.id}:`, error.message);
      results.push({ profile: profile.id, applied: 0, error: error.message });
    }
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Total profiles processed: ${profiles.length}`);
  console.log(`Total jobs applied: ${totalApplied}`);
  results.forEach(r => {
    console.log(`  - ${r.profile}: ${r.applied} jobs${r.error ? ` (Error: ${r.error})` : ''}`);
  });
  console.log(`================\n`);

  return results;
};

const configurePreferences = async (user) => {
  preferences = await getPreferences(user);
  localStorage.setItem("preferences", preferences);
  writeToFile(preferences, "preferences", user.id);
  return preferences;
}

const handleMainMenu = async (user, preferences) => {
  while(true){
    let res = await showMainMenu();
    if(!preferences) res = "configure";
    switch (res) {
      case "search-jobs":
        await doTheStuff(user, preferences);
        break;
      case "use-existing-jobs":
        await doTheStuff(user, preferences, true);
        break;
      case "send-emails":
        await handleEmailsMenu();
        break;
      case "analytics":
        await showAnalytics(user);
        break;
      case "reset":
        await resetAccount(user);
        await restartProgram();
        break;
      case "check-updates":
        await prompts.input({
          message: "Restart is required. Press ENTER to restart...",
        });
        await restartProgram();
        break;
      case "exit":
        process.exit(0);
      case "restart":
        await restartProgram();
        break;
      case "configure":
        preferences = await configurePreferences(user);
        return preferences;
      default:
        break;
    }
  }
};

const showAnalytics = async (user) => {
  const stats = analyticsManager.getStats();
  
  console.clear();
  console.log("\n📊 Application Usage Statistics");
  console.log("=============================");
  console.log(`Last Updated: ${new Date(stats.lastUpdated).toLocaleString()}`);
  console.log(`Using this app since: ${new Date(stats.createDate).toLocaleString()}`);
  console.log("\nTotal Statistics:");
  console.log(`- Jobs Applied: ${stats.totalJobsApplied}`);
  console.log(`- Questions Answered: ${stats.totalQuestionsAnswered}`);
  console.log(`- Emails Sent: ${stats.totalEmailsSent}`);
  
  console.log("\nLast 7 Days Statistics:");
  if(stats.dailyStats){
    Object.entries(stats.dailyStats).forEach(([date, dayStats]) => {
      console.log(`\n${new Date(date).toLocaleDateString()}:`);
      console.log(`- Jobs Applied: ${dayStats.jobsApplied}`);
      console.log(`- Questions Answered: ${dayStats.questionsAnswered}`);
      console.log(`- Emails Sent: ${dayStats.emailsSent}`);
    });
  }else{
    console.log("No daily stats available");
  }

  await prompts.input({
    message: "\nPress ENTER to continue...",
  });
};

const startSequence = async () => {
  const startPhrase = await getUnusedPhrase();
  await streamText(startPhrase, 50);
  await new Promise(resolve => setTimeout(resolve, 200));
};

const startProgram = async () => {
  try {
    await startSequence();
    await autoUpdate();
    const profile = await selectProfile();

    // Handle "Apply to ALL profiles" selection
    if (profile === "all-profiles") {
      await runMultiProfileFlow();
      return;
    }

    if (!profile) {
      // "Add New Profile" selected - login will prompt for credentials
      console.log("\n--- Add New Profile ---");
    }

    const loginInfo = await login(profile);
    const authorization = loginInfo.authorization;
    localStorage.setItem("authorization", authorization);
    const user = await getUserProfile();
    localStorage.setItem("profile", user);
    const updatedProfiles = await manageProfiles(user, loginInfo);
    writeFileData(updatedProfiles, "profiles");
    analyticsManager.loadStats();

    if (isDebugMode) console.clear();
    let preferences = await getDataFromFile("preferences");
    if(!preferences) preferences = await configurePreferences(user);
    localStorage.setItem("preferences", preferences);
    preferences = await handleMainMenu(user, preferences);
    if(preferences) await doTheStuff(user, preferences);
    else{
      console.log("Please configure the application first");
    }
  } catch (e) {
    if(e instanceof Error && (e.name === 'ExitPromptError' || e.message === 'ExitPromptError')){
      console.log("👋 until next time!");
    }else{
      console.log("Error in main process:", isDebugMode ? e : e.message);
    }
  } finally {
    console.log("Program ended");
    await prompts.input({
      message: "Press ENTER to exit...",
    });
    rl.close();
  }
};

// Multi-profile application flow
const runMultiProfileFlow = async () => {
  console.clear();
  console.log("\n=== Multi-Profile Job Application ===");

  // Get all profiles
  const allProfiles = await getFileData("profiles");
  if (!allProfiles || allProfiles.length === 0) {
    console.log("No profiles found. Please add profiles first.");
    return;
  }

  console.log(`Profiles available: ${allProfiles.map(p => p.id).join(", ")}`);

  // Ask if using existing jobs or new search
  const jobSource = await prompts.select({
    message: "Job source:",
    choices: [
      { name: "Search for new jobs", value: "new" },
      { name: "Use previously searched jobs", value: "existing" },
    ],
  });

  // Use each profile's own dailyQuota from preferences (no global max prompt)
  await processAllProfiles(allProfiles, null, jobSource === "existing");
};

// Handle process exit
process.on('exit', (code) => {
  console.log(`👋 See you next time!`);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  spinner.stop();
  rl.close();
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  spinner.stop();
  rl.close();
  process.exit(1);
});

// Handle SIGINT (Ctrl+C)
process.on("SIGINT", async () => {
  try {
    console.log("\nShutting down...");
    spinner.stop();
    rl.close();
    console.log("👋 Goodbye!");
    process.exit(0);
  } catch (error) {
    console.error("Error during shutdown:", error);
    process.exit(1);
  }
});

// Handle SIGTERM (normal termination)
process.on("SIGTERM", async () => {
  try {
    console.log("\nReceived SIGTERM. Shutting down...");
    spinner.stop();
    rl.close();
    console.log("👋 Goodbye!");
    process.exit(0);
  } catch (error) {
    console.error("Error during shutdown:", error);
    process.exit(1);
  }
});

if(!isDebugMode){
  process.removeAllListeners('warning');
}

startProgram();

