import React, { createContext, useContext, useEffect, useState, useCallback } from 'react'

interface Message {
    id: string
    role: 'user' | 'assistant'
    content: string
    timestamp: number
    isStreaming?: boolean
}

export interface FileManifest {
    id: string
    name: string
    mimeType: string
    size: number
}

interface ChatContextType {
    messages: Message[]
    isLoading: boolean
    files: FileManifest[]
    codeInterpreterEnabled: boolean

    sendMessage: (content: string) => Promise<void>
    clearChat: () => void
    uploadFiles: () => Promise<void>
    removeFile: (fileId: string) => Promise<void>
    toggleCodeInterpreter: () => void

    getPageContent: () => Promise<string | null>
    getPageText: () => Promise<string | null>
    getCurrentUrl: () => Promise<string | null>
}

const ChatContext = createContext<ChatContextType | null>(null)

export const useChat = () => {
    const context = useContext(ChatContext)
    if (!context) {
        throw new Error('useChat must be used within a ChatProvider')
    }
    return context
}

export const ChatProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [messages, setMessages] = useState<Message[]>([])
    const [isLoading, setIsLoading] = useState(false)
    const [files, setFiles] = useState<FileManifest[]>([])
    const [codeInterpreterEnabled, setCodeInterpreterEnabled] = useState(false)

    useEffect(() => {
        const loadInitialState = async () => {
            try {
                const storedMessages = await window.sidebarAPI.getMessages()
                if (storedMessages && storedMessages.length > 0) {
                    const convertedMessages = storedMessages.map((msg: any, index: number) => ({
                        id: `msg-${index}`,
                        role: msg.role,
                        content: typeof msg.content === 'string'
                            ? msg.content
                            : msg.content.find((p: any) => p.type === 'text')?.text || '',
                        timestamp: Date.now(),
                        isStreaming: false
                    }))
                    setMessages(convertedMessages)
                }

                const existingFiles = await window.sidebarAPI.getFiles()
                if (existingFiles) setFiles(existingFiles)
            } catch (error) {
                console.error('Failed to load initial state:', error)
            }
        }
        loadInitialState()
    }, [])

    const sendMessage = useCallback(async (content: string) => {
        setIsLoading(true)

        try {
            const messageId = Date.now().toString()

            // Explicit ask fallback: if user types "run/execute/code interpreter", allow it even if toggle is off.
            const allowByWording = /(code interpreter|run python|run javascript|run js|execute|run code)/i.test(content)

            await window.sidebarAPI.sendChatMessage({
                message: content,
                messageId: messageId
                ,
                allowCodeExecution: codeInterpreterEnabled || allowByWording
            })
        } catch (error) {
            console.error('Failed to send message:', error)
        } finally {
            setIsLoading(false)
        }
    }, [codeInterpreterEnabled])

    const clearChat = useCallback(async () => {
        try {
            await window.sidebarAPI.clearChat()
            setMessages([])
            setFiles([])
        } catch (error) {
            console.error('Failed to clear chat:', error)
        }
    }, [])

    const uploadFiles = useCallback(async () => {
        try {
            const manifest = await window.sidebarAPI.uploadFiles()
            if (manifest) setFiles(manifest)
        } catch (error) {
            console.error('Failed to upload files:', error)
        }
    }, [])

    const removeFile = useCallback(async (fileId: string) => {
        try {
            const manifest = await window.sidebarAPI.removeFile(fileId)
            setFiles(manifest)
        } catch (error) {
            console.error('Failed to remove file:', error)
        }
    }, [])

    const toggleCodeInterpreter = useCallback(() => {
        setCodeInterpreterEnabled(v => !v)
    }, [])

    const getPageContent = useCallback(async () => {
        try {
            return await window.sidebarAPI.getPageContent()
        } catch (error) {
            console.error('Failed to get page content:', error)
            return null
        }
    }, [])

    const getPageText = useCallback(async () => {
        try {
            return await window.sidebarAPI.getPageText()
        } catch (error) {
            console.error('Failed to get page text:', error)
            return null
        }
    }, [])

    const getCurrentUrl = useCallback(async () => {
        try {
            return await window.sidebarAPI.getCurrentUrl()
        } catch (error) {
            console.error('Failed to get current URL:', error)
            return null
        }
    }, [])

    useEffect(() => {
        const handleChatResponse = (data: { messageId: string; content: string; isComplete: boolean }) => {
            if (data.isComplete) {
                setIsLoading(false)
            }
        }

        const handleMessagesUpdated = (updatedMessages: any[]) => {
            const convertedMessages = updatedMessages.map((msg: any, index: number) => ({
                id: `msg-${index}`,
                role: msg.role,
                content: typeof msg.content === 'string'
                    ? msg.content
                    : msg.content.find((p: any) => p.type === 'text')?.text || '',
                timestamp: Date.now(),
                isStreaming: false
            }))
            setMessages(convertedMessages)
        }

        window.sidebarAPI.onChatResponse(handleChatResponse)
        window.sidebarAPI.onMessagesUpdated(handleMessagesUpdated)

        return () => {
            window.sidebarAPI.removeChatResponseListener()
            window.sidebarAPI.removeMessagesUpdatedListener()
        }
    }, [])

    const value: ChatContextType = {
        messages,
        isLoading,
        files,
        codeInterpreterEnabled,
        sendMessage,
        clearChat,
        uploadFiles,
        removeFile,
        toggleCodeInterpreter,
        getPageContent,
        getPageText,
        getCurrentUrl
    }

    return (
        <ChatContext.Provider value={value}>
            {children}
        </ChatContext.Provider>
    )
}

