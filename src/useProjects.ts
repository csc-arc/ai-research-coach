/**
 * Fetches the list of available research projects from the public
 * csc-arc/research-projects GitHub repo via the Contents API.
 *
 * Each project lives at projects/<slug>/project.md with YAML frontmatter
 * containing at minimum: title, pi, description.
 */

import { useEffect, useState } from 'react';

export interface Project {
  slug: string;
  title: string;
  pi: string;
  description: string;
}

export type ProjectsState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; projects: Project[] };

const PROJECTS_REPO = 'csc-arc/research-projects';
const PROJECTS_PATH = 'projects';

/**
 * Parse simple YAML frontmatter (--- ... ---) into a string→string map.
 * Handles quoted values and single-line scalars only — sufficient for
 * title/pi/description. Block scalars (| and >) are not supported.
 */
function parseFrontmatter(markdown: string): Record<string, string> {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const raw = line.slice(colon + 1).trim();
    // Strip surrounding quotes if present
    const value = raw.replace(/^["']|["']$/g, '');
    if (key && value) result[key] = value;
  }
  return result;
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
            const fm = parseFrontmatter(text);
            return {
              slug,
              title: fm['title'] ?? slug,
              pi: fm['pi'] ?? '',
              description: fm['description'] ?? '',
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
