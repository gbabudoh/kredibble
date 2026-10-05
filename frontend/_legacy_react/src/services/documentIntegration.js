// frontend/src/services/documentIntegration.js
/**
 * Handles secure file uploads and structures the extracted text into the local AI context window.
 * @param {File} fileObject - The raw browser file from a drop zone or file picker.
 * @param {KreddibleEngine} initializedEngine - Running AI engine instance wrapper.
 * @param {Function} updateUiCallback - Callback to push status strings to UI layout.
 */
export async function processAndQueryDocument(fileObject, initializedEngine, updateUiCallback) {
  try {
    if (updateUiCallback) updateUiCallback("Streaming document securely to memory parser (RAM isolated)...");

    // 1. Pack the file payload for transport
    const formData = new FormData();
    formData.append("file", fileObject);

    // 2. Transmit to local FastAPI memory extraction endpoint
    const response = await fetch("/api/v1/docs/parse", {
      method: "POST",
      body: formData
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ detail: "Failed to parse document" }));
      throw new Error(errorData.detail || "Failed to parse corporate document.");
    }

    const data = await response.json();
    if (updateUiCallback) {
      updateUiCallback(`Extraction complete. ${data.character_count} chars loaded in volatile RAM across ${data.page_count} page(s).`);
    }

    // 3. Inject parsed text into a targeted system context window
    const documentContextPrompt = `You are Kredibble, a DataPrivate corporate assistant. The user has securely loaded an internal document titled "${data.filename}". Use the following extracted document text content to answer questions accurately and with strict compliance. Never hallucinate details outside this context.

[START DOCUMENT TEXT]
${data.extracted_text}
[END DOCUMENT TEXT]`;

    // 4. Return structured prompt setup
    return {
      filename: data.filename,
      charCount: data.character_count,
      pageCount: data.page_count,
      systemPromptOverride: documentContextPrompt,
      extractedText: data.extracted_text,
      initialUserGreeting: `I have analyzed "${data.filename}" locally in volatile memory (${data.character_count} characters, ${data.page_count} page${data.page_count > 1 ? 's' : ''}). What would you like to inspect or verify?`
    };
  } catch (error) {
    console.error("Document integration error:", error);
    if (updateUiCallback) updateUiCallback(`Secure Integration Failure: ${error.message}`);
    throw error;
  }
}
