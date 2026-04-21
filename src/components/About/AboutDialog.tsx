import GitHubIcon from "@mui/icons-material/GitHub";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Link,
  Typography,
} from "@mui/material";
import { FunctionComponent } from "react";

interface AboutDialogProps {
  open: boolean;
  onClose: () => void;
}

const AboutDialog: FunctionComponent<AboutDialogProps> = ({ open, onClose }) => {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>About AI Research Coach</DialogTitle>
      <DialogContent>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 2, pt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            An AI assistant for research coaching, with student- and project-scoped
            workspaces backed by a remote script execution server.
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Forked from{" "}
            <Link
              href="https://github.com/magland/chatgeneral"
              target="_blank"
              rel="noopener noreferrer"
            >
              magland/chatgeneral
            </Link>
            .
          </Typography>
          <Box>
            <Link
              href="https://github.com/arc-csc/ai-research-coach"
              target="_blank"
              rel="noopener noreferrer"
              sx={{
                display: "inline-flex",
                alignItems: "center",
                gap: 1,
                textDecoration: "none",
              }}
            >
              <GitHubIcon fontSize="small" />
              <Typography variant="body2">View on GitHub</Typography>
            </Link>
          </Box>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
};

export default AboutDialog;
