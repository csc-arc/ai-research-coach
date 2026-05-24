import {
  Box,
  Collapse,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Typography,
} from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import { useCallback, useState } from "react";
import { IndexTree } from "./piApi";

interface SelectedSession {
  pi: string;
  project: string;
  student: string;
  ts: string;
}

interface PINavigatorProps {
  tree: IndexTree;
  selected: SelectedSession | null;
  onSelect: (pi: string, project: string, student: string, ts: string) => void;
}

const formatTimestamp = (ts: string): string => {
  // Sessions are named with ISO-8601 timestamps (e.g.
  // 2026-05-23T17:46:11+00:00). Render a friendlier date for the navigator.
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return ts;
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return ts;
  }
};

export default function PINavigator({
  tree,
  selected,
  onSelect,
}: PINavigatorProps) {
  // Track collapse state per PI / project / student. Default: PI nodes
  // collapsed except the one containing the selected session (if any).
  const [openKeys, setOpenKeys] = useState<Set<string>>(() => {
    const out = new Set<string>();
    if (selected) {
      out.add(`pi:${selected.pi}`);
      out.add(`pj:${selected.pi}/${selected.project}`);
      out.add(`st:${selected.pi}/${selected.project}/${selected.student}`);
    }
    return out;
  });

  const toggle = useCallback((key: string) => {
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const piNames = Object.keys(tree).sort();

  if (piNames.length === 0) {
    return (
      <Box sx={{ p: 2, color: "text.secondary" }}>
        <Typography variant="body2">
          No sessions yet. Once a coaching session ends, it will appear here.
        </Typography>
      </Box>
    );
  }

  return (
    <List dense sx={{ py: 1 }}>
      {piNames.map((pi) => {
        const piKey = `pi:${pi}`;
        const piOpen = openKeys.has(piKey);
        const projects = tree[pi];
        const projectNames = Object.keys(projects).sort();
        return (
          <Box key={pi}>
            <ListItemButton onClick={() => toggle(piKey)} sx={{ pl: 1 }}>
              <IconButton size="small" edge="start" sx={{ mr: 0.5 }}>
                {piOpen ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
              </IconButton>
              <ListItemText
                primary={pi}
                primaryTypographyProps={{ variant: "subtitle2" }}
              />
            </ListItemButton>
            <Collapse in={piOpen} timeout="auto" unmountOnExit>
              {projectNames.map((project) => {
                const pjKey = `pj:${pi}/${project}`;
                const pjOpen = openKeys.has(pjKey);
                const studentNames = Object.keys(projects[project]).sort();
                return (
                  <Box key={project}>
                    <ListItemButton
                      onClick={() => toggle(pjKey)}
                      sx={{ pl: 3 }}
                    >
                      <IconButton size="small" edge="start" sx={{ mr: 0.5 }}>
                        {pjOpen ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
                      </IconButton>
                      <ListItemText
                        primary={project}
                        primaryTypographyProps={{ variant: "body2" }}
                      />
                    </ListItemButton>
                    <Collapse in={pjOpen} timeout="auto" unmountOnExit>
                      {studentNames.map((student) => {
                        const stKey = `st:${pi}/${project}/${student}`;
                        const stOpen = openKeys.has(stKey);
                        const sessions = projects[project][student] || [];
                        return (
                          <Box key={student}>
                            <ListItemButton
                              onClick={() => toggle(stKey)}
                              sx={{ pl: 5 }}
                            >
                              <IconButton size="small" edge="start" sx={{ mr: 0.5 }}>
                                {stOpen ? (
                                  <ExpandMoreIcon fontSize="small" />
                                ) : (
                                  <ChevronRightIcon fontSize="small" />
                                )}
                              </IconButton>
                              <ListItemText
                                primary={student}
                                primaryTypographyProps={{ variant: "body2" }}
                                secondary={`${sessions.length} session${sessions.length === 1 ? "" : "s"}`}
                                secondaryTypographyProps={{ variant: "caption" }}
                              />
                            </ListItemButton>
                            <Collapse in={stOpen} timeout="auto" unmountOnExit>
                              {sessions.map((ts) => {
                                const isSelected =
                                  !!selected &&
                                  selected.pi === pi &&
                                  selected.project === project &&
                                  selected.student === student &&
                                  selected.ts === ts;
                                return (
                                  <ListItemButton
                                    key={ts}
                                    selected={isSelected}
                                    onClick={() =>
                                      onSelect(pi, project, student, ts)
                                    }
                                    sx={{ pl: 8 }}
                                  >
                                    <ListItemText
                                      primary={formatTimestamp(ts)}
                                      primaryTypographyProps={{
                                        variant: "caption",
                                      }}
                                      secondary={ts}
                                      secondaryTypographyProps={{
                                        variant: "caption",
                                        sx: { opacity: 0.6, fontFamily: "monospace" },
                                      }}
                                    />
                                  </ListItemButton>
                                );
                              })}
                            </Collapse>
                          </Box>
                        );
                      })}
                    </Collapse>
                  </Box>
                );
              })}
            </Collapse>
          </Box>
        );
      })}
    </List>
  );
}
