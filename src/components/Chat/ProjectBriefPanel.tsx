import MenuBookIcon from "@mui/icons-material/MenuBook";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import { Box, Collapse, Divider, IconButton, Typography } from "@mui/material";
import { useState } from "react";
import MarkdownContent from "../../react-ai-chat/components/MarkdownContent";

interface ProjectBriefPanelProps {
  projectDescription: string;
}

export function ProjectBriefPanel({ projectDescription }: ProjectBriefPanelProps) {
  const [open, setOpen] = useState(false);

  return (
    <Box sx={{ borderBottom: 1, borderColor: "divider", flexShrink: 0 }}>
      {/* Toggle bar */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          px: 1.5,
          py: 0.5,
          cursor: "pointer",
          userSelect: "none",
          "&:hover": { bgcolor: "action.hover" },
        }}
        onClick={() => setOpen((v) => !v)}
        role="button"
        aria-expanded={open}
        aria-label={open ? "Collapse project brief" : "Expand project brief"}
      >
        <MenuBookIcon fontSize="small" sx={{ mr: 1, color: "text.secondary" }} />
        <Typography variant="body2" sx={{ fontWeight: 500, flexGrow: 1 }}>
          Project Brief
        </Typography>
        <IconButton size="small" tabIndex={-1} aria-hidden>
          {open ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
        </IconButton>
      </Box>

      {/* Collapsible content */}
      <Collapse in={open} unmountOnExit>
        <Divider />
        <Box
          sx={{
            maxHeight: "40vh",
            overflow: "auto",
            px: 2,
            py: 1.5,
            "& a": { wordBreak: "break-word" },
          }}
        >
          <MarkdownContent content={projectDescription} />
        </Box>
      </Collapse>
    </Box>
  );
}
