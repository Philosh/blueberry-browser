import { ipcMain, WebContents } from "electron";
import type { Window } from "./Window";

type GetWindow = () => Window | null;

export class EventManager {
  private readonly getWindow: GetWindow;
  private readonly handlerChannels = new Set<string>();
  private readonly listenerChannels = new Set<string>();

  constructor(getWindow: GetWindow) {
    this.getWindow = getWindow;
    this.setupEventHandlers();
  }

  private withWindow<T>(fn: (window: Window) => T): T | null {
    const window = this.getWindow();
    if (!window) return null;
    return fn(window);
  }

  private registerHandle<T extends any[], R>(
    channel: string,
    handler: (event: Electron.IpcMainInvokeEvent, ...args: T) => R | Promise<R>
  ): void {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, handler);
    this.handlerChannels.add(channel);
  }

  private registerListener(
    channel: string,
    listener: (event: Electron.IpcMainEvent, ...args: any[]) => void
  ): void {
    ipcMain.removeAllListeners(channel);
    ipcMain.on(channel, listener);
    this.listenerChannels.add(channel);
  }

  private setupEventHandlers(): void {
    this.handleTabEvents();
    this.handleSidebarEvents();
    this.handlePageContentEvents();
    this.handleDarkModeEvents();
    this.handleDebugEvents();
  }

  private handleTabEvents(): void {
    this.registerHandle("create-tab", (_, url?: string) =>
      this.withWindow((window) => {
        const newTab = window.createTab(url);
        return { id: newTab.id, title: newTab.title, url: newTab.url };
      })
    );

    this.registerHandle("close-tab", (_, id: string) =>
      this.withWindow((window) => window.closeTab(id))
    );

    this.registerHandle("switch-tab", (_, id: string) =>
      this.withWindow((window) => window.switchActiveTab(id))
    );

    this.registerHandle("get-tabs", () =>
      this.withWindow((window) => {
        const activeTabId = window.activeTab?.id;
        return window.allTabs.map((tab) => ({
          id: tab.id,
          title: tab.title,
          url: tab.url,
          isActive: activeTabId === tab.id,
        }));
      })
    );

    this.registerHandle("navigate-to", (_, url: string) =>
      this.withWindow((window) => {
        if (window.activeTab) window.activeTab.loadURL(url);
        return true;
      })
    );

    this.registerHandle("navigate-tab", async (_, tabId: string, url: string) =>
      this.withWindow(async (window) => {
        const tab = window.getTab(tabId);
        if (!tab) return false;
        await tab.loadURL(url);
        return true;
      })
    );

    this.registerHandle("tab-go-back", (_, tabId: string) =>
      this.withWindow((window) => {
        const tab = window.getTab(tabId);
        if (!tab) return false;
        tab.goBack();
        return true;
      })
    );

    this.registerHandle("tab-go-forward", (_, tabId: string) =>
      this.withWindow((window) => {
        const tab = window.getTab(tabId);
        if (!tab) return false;
        tab.goForward();
        return true;
      })
    );

    this.registerHandle("tab-reload", (_, tabId: string) =>
      this.withWindow((window) => {
        const tab = window.getTab(tabId);
        if (!tab) return false;
        tab.reload();
        return true;
      })
    );

    this.registerHandle("tab-screenshot", async (_, tabId: string) =>
      this.withWindow(async (window) => {
        const tab = window.getTab(tabId);
        if (!tab) return null;
        const image = await tab.screenshot();
        return image.toDataURL();
      })
    );

    this.registerHandle("tab-run-js", async (_, tabId: string, code: string) =>
      this.withWindow(async (window) => {
        const tab = window.getTab(tabId);
        if (!tab) return null;
        return await tab.runJs(code);
      })
    );

    this.registerHandle("get-active-tab-info", () =>
      this.withWindow((window) => {
        const activeTab = window.activeTab;
        if (!activeTab) return null;
        return {
          id: activeTab.id,
          url: activeTab.url,
          title: activeTab.title,
          canGoBack: activeTab.webContents.canGoBack(),
          canGoForward: activeTab.webContents.canGoForward(),
        };
      })
    );
  }

  private handleSidebarEvents(): void {
    this.registerHandle("toggle-sidebar", () =>
      this.withWindow((window) => {
        window.sidebar.toggle();
        window.updateAllBounds();
        return true;
      })
    );

    this.registerHandle("sidebar-chat-message", async (_, request) =>
      this.withWindow(async (window) => {
        await window.sidebar.client.sendChatMessage(request);
        return true;
      })
    );

    this.registerHandle("sidebar-clear-chat", () =>
      this.withWindow((window) => {
        window.sidebar.client.clearMessages();
        return true;
      })
    );

    this.registerHandle("sidebar-get-messages", () =>
      this.withWindow((window) => window.sidebar.client.getMessages())
    );
  }

  private handlePageContentEvents(): void {
    this.registerHandle("get-page-content", async () =>
      this.withWindow(async (window) => {
        if (!window.activeTab) return null;
        try {
          return await window.activeTab.getTabHtml();
        } catch (error) {
          console.error("Error getting page content:", error);
          return null;
        }
      })
    );

    this.registerHandle("get-page-text", async () =>
      this.withWindow(async (window) => {
        if (!window.activeTab) return null;
        try {
          return await window.activeTab.getTabText();
        } catch (error) {
          console.error("Error getting page text:", error);
          return null;
        }
      })
    );

    this.registerHandle("get-current-url", () =>
      this.withWindow((window) => window.activeTab?.url ?? null)
    );
  }

  private handleDarkModeEvents(): void {
    this.registerListener("dark-mode-changed", (event, isDarkMode) => {
      this.broadcastDarkMode(event.sender, isDarkMode);
    });
  }

  private handleDebugEvents(): void {
    this.registerListener("ping", () => console.log("pong"));
  }

  private broadcastDarkMode(sender: WebContents, isDarkMode: boolean): void {
    const window = this.getWindow();
    if (!window) return;

    if (window.topBar.view.webContents !== sender) {
      window.topBar.view.webContents.send("dark-mode-updated", isDarkMode);
    }

    if (window.sidebar.view.webContents !== sender) {
      window.sidebar.view.webContents.send("dark-mode-updated", isDarkMode);
    }

    window.allTabs.forEach((tab) => {
      if (tab.webContents !== sender) {
        tab.webContents.send("dark-mode-updated", isDarkMode);
      }
    });
  }

  public cleanup(): void {
    this.listenerChannels.forEach((channel) => ipcMain.removeAllListeners(channel));
    this.handlerChannels.forEach((channel) => ipcMain.removeHandler(channel));
  }
}

