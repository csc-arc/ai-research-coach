/**
 * Fetches the list of available research projects from the public
 * csc-arc/research-projects GitHub repo via the Contents API.
 *
 * Each project lives at projects/<slug>/project.md. The file format is:
 *   ---
 *   title: "..."
 *   pi: "..."
 *   goals:           # optional
 *     - "..."
 *   ---
 *
 *   <Markdown body — this is the project description>
 *
 * The first paragraph of the body is used as a short preview ("description")
 * shown in the project picker. The full body is what the coach reads as the
 * project description at runtime (handled server-side by start_session).
 */

import { useEffect, useState } from 'react';

export interface Project {
  slug: string;
  title: string;
  pi: string;
  /**
   * A short, single-paragraph preview of the project body, suitable for the
   * project picker's secondary text. The full project description is the
   * body of project.md and is loaded server-side at session start.
   */
  description: string;
}

export type ProjectsState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; projects: Project[] };

const PROJECTS_REPO = 'csc-arc/research-projects';
const PROJECTS_PATH = 'projects';

interface ParsedProjectMd {
  /** Single-line scalar frontmatter values (e.g. title, pi). */
  scalars: Record<string, string>;
  /** Markdown body following the frontmatter. */
  body: string;
}

/**
 * Parse a project.md into its YAML scalar frontmatter values and the body.
 * Only single-line scalar values are extracted from the frontmatter; YAML
 * lists (e.g. `goals:`) are intentionally ignored — the picker only needs
 * `title` and `pi`. Block scalars (`|` and `>`) are not supported.
 */
function parseProjectMd(markdown: string): ParsedProjectMd {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { scalars: {}, body: markdown };

  const scalars: Record<string, string> = {};
  const fmLines = match[1].split(/\r?\n/);
  for (const line of fmLines) {
    // Skip indented lines (continuations or list items under a parent key).
    if (/^\s/.test(line)) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const raw = line.slice(colon + 1).trim();
    if (!key || !raw) continue;
    // Strip surrounding quotes if present.
    const value = raw.replace(/^["']|["']$/g, '');
    scalars[key] = value;
  }

  return { scalars, body: match[2] };
}

/**
 * Extract a short, picker-friendly preview from the markdown body. Skips
 * leading blank lines and ATX headings (`# ...`) and returns the first
 * non-empty prose paragraph collapsed to a single line.
 */
function extractBodyPreview(body: string): string {
  const lines = body.split(/\r?\n/);
  const paragraph: string[] = [];
  let inParagraph = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') {
      if (inParagraph) break;
      continue;
    }
    if (line.startsWith('#')) {
      if (inParagraph) break;
      continue;
    }
    paragraph.push(line);
    inParagraph = true;
  }

  return paragraph.join(' ').trim();
}

export function useProjects(): ProjectsState {
  const [state, setState] = useState<ProjectsState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const listUrl = `https://api.github.com/repos/${PROJECTS_REPO}/contents/${PROJECTS_PATH}`;
        const listRes = await fetch(listUrl);
        if (!listRes.ok) {
          throw new Error(`GitHub API returned ${listRes.status} for project list`);
        }
        const entries: Array<{ name: string; type: string }> = await listRes.json();
        const slugs = entries.filter((e) => e.type === 'dir').map((e) => e.name);

        const settled = await Promise.allSettled(
          slugs.map(async (slug): Promise<Project> => {
            const rawUrl = `https://raw.githubusercontent.com/${PROJECTS_REPO}/main/${PROJECTS_PATH}/${slug}/project.md`;
            const res = await fetch(rawUrl);
            if (!res.ok) throw new Error(`${slug}/project.md: ${res.status}`);
            const text = await res.text();
            const { scalars, body } = parseProjectMd(text);
            return {
              slug,
              title: scalars['title'] ?? slug,
              pi: scalars['pi'] ?? '',
              description: extractBodyPreview(body),
            };
          })
        );

        if (cancelled) return;

        const projects: Project[] = [];
        for (const result of settled) {
          if (result.status === 'fulfilled') {
            projects.push(result.value);
          } else {
            console.warn('Failed to load a project:', result.reason);
          }
        }

        setState({ status: 'ok', projects });
      } catch (err) {
        if (!cancelled) {
          setState({ status: 'error', message: String(err) });
        }
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
