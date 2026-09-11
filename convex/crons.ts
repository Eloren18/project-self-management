import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

// Housekeeping that nothing else guarantees: expired sessions, stale sign-in
// codes and security-log rows past their retention window.
const crons = cronJobs();
crons.daily("maintenance cleanup", { hourUTC: 3, minuteUTC: 15 }, internal.maintenance.cleanup, {});
export default crons;
