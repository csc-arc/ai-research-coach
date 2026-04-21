/**
 * Passcode storage utility for server authentication.
 * Stored in sessionStorage, keyed by server URL.
 */

function getStorageKey(serverUrl: string): string {
  return `airesearchcoach_passcode_${serverUrl}`;
}

export function getStoredPasscode(serverUrl: string): string | null {
  try {
    return sessionStorage.getItem(getStorageKey(serverUrl));
  } catch (error) {
    console.error("Error reading passcode from sessionStorage:", error);
    return null;
  }
}

export function storePasscode(serverUrl: string, passcode: string): void {
  try {
    sessionStorage.setItem(getStorageKey(serverUrl), passcode);
  } catch (error) {
    console.error("Error storing passcode in sessionStorage:", error);
  }
}

export function clearPasscode(serverUrl: string): void {
  try {
    sessionStorage.removeItem(getStorageKey(serverUrl));
  } catch (error) {
    console.error("Error clearing passcode from sessionStorage:", error);
  }
}

/**
 * Prompt the user for a passcode using window.prompt.
 * Returns the passcode if entered, or null if cancelled / blank.
 */
export function promptForPasscode(serverUrl: string): string | null {
  const passcode = window.prompt(
    `Enter passcode for server:\n${serverUrl}`,
    ""
  );

  if (passcode !== null && passcode.trim() !== "") {
    return passcode.trim();
  }

  return null;
}

/**
 * Get a passcode for a server, prompting the user if not already stored.
 * Stores the passcode if successfully entered.
 */
export async function getOrPromptPasscode(serverUrl: string): Promise<string | null> {
  let passcode = getStoredPasscode(serverUrl);
  if (passcode) {
    return passcode;
  }

  passcode = promptForPasscode(serverUrl);
  if (passcode) {
    storePasscode(serverUrl, passcode);
  }
  return passcode;
}
