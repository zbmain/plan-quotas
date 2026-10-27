/** Copy on HTTPS when available, falling back to a selection copy for HTTP deployments. */
export async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // A denied Clipboard API must still allow the HTTP-compatible selection path to try.
  }

  const previousFocus = document.activeElement as HTMLElement | null;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.tabIndex = -1;
  textarea.setAttribute("aria-hidden", "true");
  Object.assign(textarea.style, {
    position: "fixed",
    left: "-9999px",
    top: "0",
    fontSize: "16px",
  });
  document.body.appendChild(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    if (!document.execCommand("copy")) throw new Error("copy_failed");
  } finally {
    // Remove the temporary value immediately, including when it contains a one-time MCP token.
    textarea.value = "";
    textarea.remove();
    previousFocus?.focus?.({ preventScroll: true });
  }
}
