const {
  getFileData,
  writeFileData,
} = require("./ioUtils");

const APPLIED_JOBS_FILE = "appliedJobs";
const MAX_AGE_DAYS = 30;

/**
 * Load applied jobs from file and clean up old entries
 * @returns {Array} Array of applied job objects
 */
const loadAppliedJobs = async () => {
  const appliedJobs = await getFileData(APPLIED_JOBS_FILE);
  if (!appliedJobs || !Array.isArray(appliedJobs)) {
    return [];
  }

  // Clean up jobs older than MAX_AGE_DAYS
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - MAX_AGE_DAYS);

  const validJobs = appliedJobs.filter((job) => {
    if (!job.appliedDate) return false;
    const appliedDate = new Date(job.appliedDate);
    return appliedDate >= cutoffDate;
  });

  // If we cleaned up entries, save the cleaned list
  if (validJobs.length !== appliedJobs.length) {
    await writeFileData(validJobs, APPLIED_JOBS_FILE);
    console.debug(`Cleaned up ${appliedJobs.length - validJobs.length} old applied job entries (older than ${MAX_AGE_DAYS} days)`);
  }

  return validJobs;
};

/**
 * Check if a job has already been applied to (across all profiles)
 * @param {string} jobId - The job ID to check
 * @returns {boolean} True if job was already applied
 */
const isJobAlreadyApplied = async (jobId) => {
  const appliedJobs = await loadAppliedJobs();
  return appliedJobs.some((job) => job.jobId === jobId);
};

/**
 * Get the profile ID that applied to a specific job
 * @param {string} jobId - The job ID to check
 * @returns {string|null} Profile ID that applied, or null if not found
 */
const getAppliedProfileId = async (jobId) => {
  const appliedJobs = await loadAppliedJobs();
  const job = appliedJobs.find((j) => j.jobId === jobId);
  return job ? job.profileId : null;
};

/**
 * Record a job application
 * @param {Object} jobInfo - Job information
 * @param {string} jobInfo.jobId - Job ID
 * @param {string} jobInfo.jobTitle - Job title
 * @param {string} jobInfo.companyName - Company name
 * @param {string} profileId - Profile ID that applied
 * @returns {Promise<void>}
 */
const recordJobApplication = async (jobInfo, profileId) => {
  const appliedJobs = await loadAppliedJobs();

  // Check if already recorded (shouldn't happen if checked before, but safety)
  const existingIndex = appliedJobs.findIndex((job) => job.jobId === jobInfo.jobId);
  const newEntry = {
    jobId: jobInfo.jobId,
    jobTitle: jobInfo.jobTitle,
    companyName: jobInfo.companyName,
    profileId: profileId,
    appliedDate: new Date().toISOString(),
  };

  if (existingIndex !== -1) {
    // Update existing entry with new profile (in case same job applied by different profile)
    appliedJobs[existingIndex] = newEntry;
  } else {
    appliedJobs.push(newEntry);
  }

  await writeFileData(appliedJobs, APPLIED_JOBS_FILE);
  console.debug(`Recorded application for job ${jobInfo.jobId} by profile ${profileId}`);
};

/**
 * Filter out jobs that have already been applied to
 * @param {Array} jobs - Array of job objects
 * @returns {Array} Filtered jobs (not yet applied)
 */
const filterAlreadyAppliedJobs = async (jobs) => {
  const appliedJobs = await loadAppliedJobs();
  const appliedJobIds = new Set(appliedJobs.map((job) => job.jobId));

  return jobs.filter((job) => !appliedJobIds.has(job.jobId));
};

/**
 * Get all applied jobs for a specific profile
 * @param {string} profileId - Profile ID
 * @returns {Array} Applied jobs for the profile
 */
const getAppliedJobsByProfile = async (profileId) => {
  const appliedJobs = await loadAppliedJobs();
  return appliedJobs.filter((job) => job.profileId === profileId);
};

/**
 * Get applied jobs statistics
 * @returns {Object} Statistics object
 */
const getAppliedJobsStats = async () => {
  const appliedJobs = await loadAppliedJobs();
  const profileCounts = {};

  appliedJobs.forEach((job) => {
    profileCounts[job.profileId] = (profileCounts[job.profileId] || 0) + 1;
  });

  return {
    totalApplications: appliedJobs.length,
    byProfile: profileCounts,
    oldestEntry: appliedJobs.length > 0 ? appliedJobs[0].appliedDate : null,
    newestEntry: appliedJobs.length > 0 ? appliedJobs[appliedJobs.length - 1].appliedDate : null,
  };
};

module.exports = {
  loadAppliedJobs,
  isJobAlreadyApplied,
  getAppliedProfileId,
  recordJobApplication,
  filterAlreadyAppliedJobs,
  getAppliedJobsByProfile,
  getAppliedJobsStats,
  MAX_AGE_DAYS,
};