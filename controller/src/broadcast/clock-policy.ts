// Gate all automatic clock references here, including prompt context and the hourly tick.
// Daypart descriptions and manual segments remain eligible; read the switch live.

import * as settings from '../settings.js';

// Absent/non-boolean reads as ON, so an upgrade is byte-identical.
export function clockEnabled(): boolean {
  return settings.get()?.djSpeakClock !== false;
}

// May a spoken line state the wall-clock time?
export function speakClockAllowed(): boolean {
  return clockEnabled();
}

// A boundary-deferred ident's daypart can go stale while its WAV waits for a
// seam. Stamp only a daypart the model was allowed to use: an ident written
// with the clock off made no clock claim and must not be dropped later.
export function stationIdDaypartStamp(daypart: unknown, clockAllowed: boolean): string | null {
  if (!clockAllowed || typeof daypart !== 'string') return null;
  return daypart.trim() || null;
}

// Air-time backstop for the stamp above. Missing/malformed stamps fail OPEN:
// they mean no validated daypart claim reached this channel.
export function stationIdDaypartDrifted(stamped: unknown, live: unknown): boolean {
  if (typeof stamped !== 'string' || !stamped.trim()) return false;
  if (typeof live !== 'string' || !live.trim()) return false;
  return stamped.trim() !== live.trim();
}

// The operator's switch for the automatic top-of-the-hour time check alone
// (djBehaviour.hourlyTimeCheck). Absent/non-boolean reads as ON.
export function hourlyTimeCheckEnabled(): boolean {
  return settings.get()?.djBehaviour?.hourlyTimeCheck !== false;
}

// May the AUTOMATIC top-of-the-hour time check fire? Manual runners must NOT
// call this — bypassing the gate is what preserves the operator's pad. Either
// switch stands it down: the clock switch keeps every clock reading off air,
// the hourly switch drops only this segment.
export function autoTimeCheckAllowed(): boolean {
  return clockEnabled() && hourlyTimeCheckEnabled();
}

// What the automatic :00 slot airs. The show welcome rides the hourly slot, so
// standing the time check down must not take a show change's welcome with it:
// with the time check off, a show boundary still airs the welcome on its own
// (no clock reading in it), and a plain hour boundary airs nothing.
export interface HourlySlotPlan {
  timeCheck: boolean;
  welcome: boolean;
}

export function decideHourlySlot(
  { timeCheckAllowed, welcomeOn, showStarted }:
    { timeCheckAllowed: boolean; welcomeOn: boolean; showStarted: boolean },
): HourlySlotPlan {
  return { timeCheck: timeCheckAllowed, welcome: welcomeOn && showStarted };
}

export function hourlySlotPlan({ showStarted = false }: { showStarted?: boolean } = {}): HourlySlotPlan {
  return decideHourlySlot({
    timeCheckAllowed: autoTimeCheckAllowed(),
    welcomeOn: settings.get()?.djBehaviour?.showWelcome === true,
    showStarted,
  });
}

export function clockStatus() {
  return { enabled: clockEnabled(), hourlyTimeCheck: hourlyTimeCheckEnabled() };
}
