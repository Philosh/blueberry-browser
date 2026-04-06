import { contextBridge } from "electron";
import { electronAPI } from "@electron-toolkit/preload";

interface ChatRequest {
  message: string;
  context: {
    url: string | null;
    content: string | null;
    text: string | null;
  };
  messageId: string;
  allowCodeExecution?: boolean;
}

interface ChatResponse {
  messageId: string;
  content: string;
  isComplete: boolean;
}

// Sidebar specific APIs
const sidebarAPI = {
  // Chat functionality
  sendChatMessage: (request: Partial<ChatRequest>) =>
    electronAPI.ipcRenderer.invoke("sidebar-chat-message", request),

  clearChat: () => electronAPI.ipcRenderer.invoke("sidebar-clear-chat"),

  getMessages: () => electronAPI.ipcRenderer.invoke("sidebar-get-messages"),

  onChatResponse: (callback: (data: ChatResponse) => void) => {
    electronAPI.ipcRenderer.on("chat-response", (_, data) => callback(data));
  },

  onMessagesUpdated: (callback: (messages: any[]) => void) => {
    electronAPI.ipcRenderer.on("chat-messages-updated", (_, messages) =>
      callback(messages)
    );
  },

  removeChatResponseListener: () => {
    electronAPI.ipcRenderer.removeAllListeners("chat-response");
  },

  removeMessagesUpdatedListener: () => {
    electronAPI.ipcRenderer.removeAllListeners("chat-messages-updated");
  },

  // Page content access
  getPageContent: () => electronAPI.ipcRenderer.invoke("get-page-content"),
  getPageText: () => electronAPI.ipcRenderer.invoke("get-page-text"),
  getCurrentUrl: () => electronAPI.ipcRenderer.invoke("get-current-url"),

  // Tab information
  getActiveTabInfo: () => electronAPI.ipcRenderer.invoke("get-active-tab-info"),

  // Sandbox file management
  uploadFiles: () => electronAPI.ipcRenderer.invoke("sandbox-upload-files"),
  removeFile: (fileId: string) =>
    electronAPI.ipcRenderer.invoke("sandbox-remove-file", fileId),
  getFiles: () => electronAPI.ipcRenderer.invoke("sandbox-get-files"),
};

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("electron", electronAPI);
    contextBridge.exposeInMainWorld("sidebarAPI", sidebarAPI);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI;
  // @ts-ignore (define in dts)
  window.sidebarAPI = sidebarAPI;
}
