import { WebContents } from "electron";
import { generateText, type LanguageModel, type CoreMessage } from "ai";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import * as dotenv from "dotenv";
import { join } from "path";
import type { Window } from "./Window";
import type { SandboxManager } from "./SandboxManager";
import { DockerCodeExecutor, type CodeLanguage } from "./DockerCodeExecutor";

// Load environment variables from .env file
dotenv.config({ path: join(__dirname, "../../.env") });

interface ChatRequest {
  message: string;
  messageId: string;
}

interface StreamChunk {
  content: string;
  isComplete: boolean;
}

type LLMProvider = "openai" | "anthropic";

const DEFAULT_MODELS: Record<LLMProvider, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-3-5-sonnet-20241022",
};

const MAX_CONTEXT_LENGTH = 4000;
const MAX_FILE_CONTEXT_LENGTH = 50_000;
const MAX_SINGLE_FILE_LENGTH = 15_000;
const MAX_CODE_INTERPRETER_STEPS = 3;
const MAX_CODE_OUTPUT_LENGTH = 20_000;
const DEFAULT_TEMPERATURE = 0.7;

export class LLMClient {
  private readonly webContents: WebContents;
  private window: Window | null = null;
  private sandboxManager: SandboxManager | null = null;
  private readonly dockerCodeExecutor: DockerCodeExecutor;
  private readonly provider: LLMProvider;
  private readonly modelName: string;
  private readonly model: LanguageModel | null;
  private messages: CoreMessage[] = [];

  constructor(webContents: WebContents) {
    this.webContents = webContents;
    this.dockerCodeExecutor = new DockerCodeExecutor();
    this.provider = this.getProvider();
    this.modelName = this.getModelName();
    this.model = this.initializeModel();

    this.logInitializationStatus();
  }

  setWindow(window: Window): void {
    this.window = window;
  }

  setSandboxManager(manager: SandboxManager): void {
    this.sandboxManager = manager;
  }

  private getProvider(): LLMProvider {
    const provider = process.env.LLM_PROVIDER?.toLowerCase();
    if (provider === "anthropic") return "anthropic";
    return "openai"; // Default to OpenAI
  }

  private getModelName(): string {
    return process.env.LLM_MODEL || DEFAULT_MODELS[this.provider];
  }

  private initializeModel(): LanguageModel | null {
    const apiKey = this.getApiKey();
    if (!apiKey) return null;

    switch (this.provider) {
      case "anthropic":
        return anthropic(this.modelName);
      case "openai":
        return openai(this.modelName);
      default:
        return null;
    }
  }

  private getApiKey(): string | undefined {
    switch (this.provider) {
      case "anthropic":
        return process.env.ANTHROPIC_API_KEY;
      case "openai":
        return process.env.OPENAI_API_KEY;
      default:
        return undefined;
    }
  }

  private logInitializationStatus(): void {
    if (this.model) {
      console.log(
        `✅ LLM Client initialized with ${this.provider} provider using model: ${this.modelName}`
      );
    } else {
      const keyName =
        this.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
      console.error(
        `❌ LLM Client initialization failed: ${keyName} not found in environment variables.\n` +
          `Please add your API key to the .env file in the project root.`
      );
    }
  }

  async sendChatMessage(request: ChatRequest): Promise<void> {
    try {
      // Get screenshot from active tab if available
      let screenshot: string | null = null;
      if (this.window) {
        const activeTab = this.window.activeTab;
        if (activeTab) {
          try {
            const image = await activeTab.screenshot();
            screenshot = image.toDataURL();
          } catch (error) {
            console.error("Failed to capture screenshot:", error);
          }
        }
      }

      const userContent: any[] = [];
      
      if (screenshot) {
        userContent.push({
          type: "image",
          image: screenshot,
        });
      }

      // Include sandbox image files in the first message that references them
      if (this.sandboxManager?.hasFiles()) {
        for (const file of this.sandboxManager.getAllFiles()) {
          if (file.mimeType.startsWith("image/")) {
            const contents = await this.sandboxManager.readFileContents(file.id);
            if (contents?.dataUrl) {
              userContent.push({
                type: "image",
                image: contents.dataUrl,
              });
            }
          }
        }
      }

      userContent.push({
        type: "text",
        text: request.message,
      });

      // Create user message in CoreMessage format
      const userMessage: CoreMessage = {
        role: "user",
        content: userContent.length === 1 ? request.message : userContent,
      };
      
      this.messages.push(userMessage);

      // Send updated messages to renderer
      this.sendMessagesToRenderer();

      if (!this.model) {
        this.sendErrorMessage(
          request.messageId,
          "LLM service is not configured. Please add your API key to the .env file."
        );
        return;
      }

      const messages = await this.prepareMessagesWithContext(request);
      await this.generateWithCodeInterpreter(request, messages, request.messageId);
    } catch (error) {
      console.error("Error in LLM request:", error);
      this.handleStreamError(error, request.messageId);
    }
  }

  private async generateWithCodeInterpreter(
    request: ChatRequest,
    messages: CoreMessage[],
    messageId: string
  ): Promise<void> {
    if (!this.model) {
      throw new Error("Model not initialized");
    }

    const workspaceDir = this.sandboxManager?.getSandboxDir();
    for (let step = 0; step < MAX_CODE_INTERPRETER_STEPS; step++) {
      const currentMessages =
        step === 0 ? messages : await this.prepareMessagesWithContext(request);

      const result = await generateText({
        model: this.model,
        messages: currentMessages,
        temperature: DEFAULT_TEMPERATURE,
        maxRetries: 3,
      });

      const assistantText = result.text ?? "";
      const directive = this.extractRunCodeDirective(assistantText);

      // If no execution directive, treat it as the final assistant response.
      if (!directive || !workspaceDir) {
        const finalText = assistantText.trim();
        this.messages.push({ role: "assistant", content: finalText });
        this.sendMessagesToRenderer();
        this.sendStreamChunk(messageId, {
          content: finalText,
          isComplete: true,
        });
        return;
      }

      const execResult = await this.dockerCodeExecutor.execute({
        language: directive.language,
        code: directive.code,
        workspaceDir,
      });

      const outputText = this.formatExecutionResult(directive.language, execResult);

      // Feed execution output back to the model as new user context.
      this.messages.push({
        role: "user",
        content: `Execution result (${directive.language}):\n${outputText}`,
      });
      this.sendMessagesToRenderer();
    }

    const fallback =
      "I couldn't complete the code execution flow. Please try again with a clearer request.";
    this.messages.push({ role: "assistant", content: fallback });
    this.sendMessagesToRenderer();
    this.sendStreamChunk(messageId, {
      content: fallback,
      isComplete: true,
    });
  }

  private extractRunCodeDirective(text: string): { language: CodeLanguage; code: string } | null {
    // Expected model output:
    // <run_code language="python">
    //   ... code ...
    // </run_code>
    const re =
      /<run_code\s+language\s*=\s*["']?(python|javascript|js)["']?\s*>([\s\S]*?)<\/run_code>/i;
    const match = text.match(re);
    if (!match) return null;

    const rawLanguage = (match[1] || "").toLowerCase();
    const language: CodeLanguage =
      rawLanguage === "python" ? "python" : "javascript";

    let code = (match[2] || "").trim();

    // Strip optional Markdown fences inside the directive.
    code = code.replace(/^```[a-zA-Z]*\n/, "").replace(/\n```$/, "");

    // Basic safety: keep code from being absurdly large.
    if (code.length > 30_000) {
      code = code.slice(0, 30_000);
    }

    return { language, code };
  }

  private formatExecutionResult(
    _language: CodeLanguage,
    result: { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }
  ): string {
    const stdout = this.truncateText(result.stdout || "", MAX_CODE_OUTPUT_LENGTH);
    const stderr = this.truncateText(result.stderr || "", MAX_CODE_OUTPUT_LENGTH);

    const exitLine = `exitCode: ${result.exitCode === null ? "null" : result.exitCode}`;
    const timeoutLine = result.timedOut ? "timedOut: true" : "timedOut: false";

    return [
      exitLine,
      timeoutLine,
      "stdout:",
      stdout || "(empty)",
      "stderr:",
      stderr || "(empty)",
    ].join("\n");
  }

  clearMessages(): void {
    this.messages = [];
    this.sendMessagesToRenderer();
  }

  getMessages(): CoreMessage[] {
    return this.messages;
  }

  private sendMessagesToRenderer(): void {
    this.webContents.send("chat-messages-updated", this.messages);
  }

  private async prepareMessagesWithContext(_request: ChatRequest): Promise<CoreMessage[]> {
    let pageUrl: string | null = null;
    let pageText: string | null = null;
    
    if (this.window) {
      const activeTab = this.window.activeTab;
      if (activeTab) {
        pageUrl = activeTab.url;
        try {
          pageText = await activeTab.getTabText();
        } catch (error) {
          console.error("Failed to get page text:", error);
        }
      }
    }

    const fileContext = await this.buildFileContext();

    const systemMessage: CoreMessage = {
      role: "system",
      content: this.buildSystemPrompt(pageUrl, pageText, fileContext),
    };

    return [systemMessage, ...this.messages];
  }

  private async buildFileContext(): Promise<string | null> {
    if (!this.sandboxManager || !this.sandboxManager.hasFiles()) return null;

    const files = this.sandboxManager.getAllFiles();
    const sections: string[] = [];
    let totalLength = 0;

    for (const file of files) {
      if (totalLength >= MAX_FILE_CONTEXT_LENGTH) {
        sections.push(
          `\n[Additional files truncated — ${files.length - sections.length} file(s) omitted due to context limits]`
        );
        break;
      }

      const contents = await this.sandboxManager.readFileContents(file.id);
      if (!contents) continue;

      if (contents.text) {
        const truncated = this.truncateText(contents.text, MAX_SINGLE_FILE_LENGTH);
        const section = `--- ${file.name} (${this.formatFileSize(file.size)}) ---\n${truncated}`;
        sections.push(section);
        totalLength += section.length;
      } else if (contents.dataUrl) {
        sections.push(
          `--- ${file.name} (${this.formatFileSize(file.size)}) ---\n[Image file — included in the conversation as an image attachment]`
        );
      }
    }

    return sections.length > 0 ? sections.join("\n\n") : null;
  }

  private formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }

  private buildSystemPrompt(
    url: string | null,
    pageText: string | null,
    fileContext: string | null
  ): string {
    const parts: string[] = [
      "You are a helpful AI assistant integrated into a web browser.",
      "You can analyze and discuss web pages with the user.",
      "The user's messages may include screenshots of the current page as the first image.",
    ];

    if (url) {
      parts.push(`\nCurrent page URL: ${url}`);
    }

    if (pageText) {
      const truncatedText = this.truncateText(pageText, MAX_CONTEXT_LENGTH);
      parts.push(`\nPage content (text):\n${truncatedText}`);
    }

    if (fileContext) {
      parts.push(
        "\n## Uploaded Files",
        "The user has uploaded the following files to a sandboxed environment. " +
          "Use ONLY these files as context when answering file-related questions. " +
          "Do not assume access to any files outside this sandbox.",
        fileContext
      );
    }

    parts.push(
      "\nPlease provide helpful, accurate, and contextual responses.",
      "If the user asks about specific content, refer to the page content, uploaded files, and/or screenshot provided.",
      "\nCode interpreter:",
      "If you need to run code to analyze the uploaded files, respond with exactly ONE block in the form:",
      "<run_code language=\"python\">...code...</run_code> or <run_code language=\"javascript\">...code...</run_code>.",
      "No other text should be included with the block.",
      "When the execution result is returned, use it to answer the user."
    );

    return parts.join("\n");
  }

  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + "...";
  }

  private handleStreamError(error: unknown, messageId: string): void {
    console.error("Error streaming from LLM:", error);

    const errorMessage = this.getErrorMessage(error);
    this.sendErrorMessage(messageId, errorMessage);
  }

  private getErrorMessage(error: unknown): string {
    if (!(error instanceof Error)) {
      return "An unexpected error occurred. Please try again.";
    }

    const message = error.message.toLowerCase();

    if (message.includes("401") || message.includes("unauthorized")) {
      return "Authentication error: Please check your API key in the .env file.";
    }

    if (message.includes("429") || message.includes("rate limit")) {
      return "Rate limit exceeded. Please try again in a few moments.";
    }

    if (
      message.includes("network") ||
      message.includes("fetch") ||
      message.includes("econnrefused")
    ) {
      return "Network error: Please check your internet connection.";
    }

    if (message.includes("timeout")) {
      return "Request timeout: The service took too long to respond. Please try again.";
    }

    return "Sorry, I encountered an error while processing your request. Please try again.";
  }

  private sendErrorMessage(messageId: string, errorMessage: string): void {
    this.sendStreamChunk(messageId, {
      content: errorMessage,
      isComplete: true,
    });
  }

  private sendStreamChunk(messageId: string, chunk: StreamChunk): void {
    this.webContents.send("chat-response", {
      messageId,
      content: chunk.content,
      isComplete: chunk.isComplete,
    });
  }
}
