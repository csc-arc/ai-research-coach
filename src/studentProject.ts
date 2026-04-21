/**
 * Student/project identity used to scope workspaces on the server.
 *
 * Source of truth (highest precedence first):
 *   1. URL query params: ?student_id=...&project_id=...
 *   2. localStorage (persistent across sessions)
 *
 * Both ids must match /^[A-Za-z0-9_-]{1,64}$/ to be accepted by the server.
 */

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEYS = {
  studentId: "airesearchcoach_student_id",
  projectId: "airesearchcoach_project_id",
} as const;

export const ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidId(value: string | null | undefined): value is string {
  return typeof value === "string" && ID_REGEX.test(value);
}

export interface StudentProject {
  studentId: string | null;
  projectId: string | null;
}

function readFromUrl(): Partial<StudentProject> {
  const params = new URLSearchParams(window.location.search);
  const out: Partial<StudentProject> = {};
  const s = params.get("student_id");
  const p = params.get("project_id");
  if (s !== null) out.studentId = s.trim();
  if (p !== null) out.projectId = p.trim();
  return out;
}

function readFromStorage(): StudentProject {
  try {
    return {
      studentId: localStorage.getItem(STORAGE_KEYS.studentId),
      projectId: localStorage.getItem(STORAGE_KEYS.projectId),
    };
  } catch {
    return { studentId: null, projectId: null };
  }
}

function writeToStorage(value: StudentProject): void {
  try {
    if (value.studentId) {
      localStorage.setItem(STORAGE_KEYS.studentId, value.studentId);
    } else {
      localStorage.removeItem(STORAGE_KEYS.studentId);
    }
    if (value.projectId) {
      localStorage.setItem(STORAGE_KEYS.projectId, value.projectId);
    } else {
      localStorage.removeItem(STORAGE_KEYS.projectId);
    }
  } catch (error) {
    console.error("Error writing student/project to localStorage:", error);
  }
}

/**
 * Resolve the initial student/project: URL params take precedence over storage.
 * URL-provided values are also persisted to storage so refreshing without the
 * params keeps the session.
 */
function resolveInitial(): StudentProject {
  const stored = readFromStorage();
  const urlValues = readFromUrl();
  const merged: StudentProject = {
    studentId: urlValues.studentId ?? stored.studentId,
    projectId: urlValues.projectId ?? stored.projectId,
  };
  if (urlValues.studentId !== undefined || urlValues.projectId !== undefined) {
    writeToStorage(merged);
  }
  return merged;
}

/**
 * React hook providing the current student_id/project_id and a setter.
 * Both ids may be null until the user provides them.
 */
export function useStudentProject() {
  const [value, setValue] = useState<StudentProject>(resolveInitial);

  // Keep storage in sync if other tabs change it
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === STORAGE_KEYS.studentId || e.key === STORAGE_KEYS.projectId) {
        setValue(readFromStorage());
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  const update = useCallback((next: StudentProject) => {
    const cleaned: StudentProject = {
      studentId: next.studentId?.trim() || null,
      projectId: next.projectId?.trim() || null,
    };
    writeToStorage(cleaned);
    setValue(cleaned);
  }, []);

  const isComplete = isValidId(value.studentId) && isValidId(value.projectId);

  return { ...value, isComplete, update };
}

/**
 * Snapshot accessor for non-React code (e.g. tool execution).
 * Returns the latest persisted values; throws if either id is missing/invalid.
 */
export function getRequiredStudentProject(): { studentId: string; projectId: string } {
  const stored = readFromStorage();
  if (!isValidId(stored.studentId) || !isValidId(stored.projectId)) {
    throw new Error(
      "student_id and project_id must be set in Settings before running scripts."
    );
  }
  return { studentId: stored.studentId, projectId: stored.projectId };
}
