import { FunctionComponent, useRef, useEffect, useCallback } from "react";
import { Box, TextField, IconButton } from "@mui/material";
import SendIcon from "@mui/icons-material/Send";
import { PasteMeta } from "../types";

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (meta?: PasteMeta) => void;
  disabled?: boolean;
  placeholder?: string;
}

const emptyPasteMeta = (): PasteMeta => ({
  paste_event_count: 0,
  paste_char_count: 0,
});

const ChatInput: FunctionComponent<ChatInputProps> = ({
  value,
  onChange,
  onSubmit,
  disabled = false,
  placeholder = "Type your message here... (Enter to send, Shift+Enter for new line)",
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Paste accumulator: incremented on every onPaste, snapshotted-and-reset
  // when a submit actually fires. Ref-held so it survives parent re-renders
  // caused by `setNewPrompt("")` happening synchronously before the
  // `onUserMessageSubmit` callback awaits.
  const pasteMetaRef = useRef<PasteMeta>(emptyPasteMeta());

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
    }
  }, [value]);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
    // text/plain length is the "intent" signal we want: it counts what the
    // browser would insert into the textarea. Image-only pastes return ""
    // which we still record as one event with chars==0 — a useful signal.
    const len = e.clipboardData?.getData("text/plain").length ?? 0;
    pasteMetaRef.current.paste_event_count += 1;
    pasteMetaRef.current.paste_char_count += len;
  }, []);

  // Single submit entry point. Both Send-button clicks and Enter key route
  // through here so the snapshot fires on every real submit. Gating on the
  // same `value.trim() !== "" && !disabled` check the parent uses keeps
  // paste history intact across no-op Enter presses.
  const triggerSubmit = useCallback(() => {
    if (value.trim() === "" || disabled) return;
    const snapshot = { ...pasteMetaRef.current };
    pasteMetaRef.current = emptyPasteMeta();
    const hadPaste = snapshot.paste_event_count > 0;
    onSubmit(hadPaste ? snapshot : undefined);
  }, [value, onSubmit, disabled]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        if (e.shiftKey) {
          // Shift+Enter: allow default behavior (new line)
          return;
        } else {
          e.preventDefault();
          triggerSubmit();
        }
      }
    },
    [triggerSubmit]
  );

  return (
    <Box
      sx={{
        p: 2,
        borderTop: 1,
        borderColor: "divider",
        backgroundColor: "background.paper",
      }}
    >
      <Box sx={{ display: "flex", gap: 1, alignItems: "flex-end" }}>
        <TextField
          inputRef={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder}
          disabled={disabled}
          multiline
          minRows={1}
          maxRows={5}
          fullWidth
          size="small"
          sx={{
            "& .MuiOutlinedInput-root": {
              borderRadius: 2,
            },
          }}
        />
        <IconButton
          color="primary"
          onClick={triggerSubmit}
          disabled={value.trim() === "" || disabled}
          sx={{
            height: 40,
            width: 40,
          }}
        >
          <SendIcon />
        </IconButton>
      </Box>
    </Box>
  );
};

export default ChatInput;
