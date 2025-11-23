'use client'

import { useState, useRef } from 'react'

type FileItem = {
    id: string
    name: string
    type: string
    size: string
}

export default function ContextPanel() {
    const [files, setFiles] = useState<FileItem[]>([])
    const [isDragging, setIsDragging] = useState(false)
    const fileInputRef = useRef<HTMLInputElement>(null)

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault()
        setIsDragging(true)
    }

    const handleDragLeave = (e: React.DragEvent) => {
        e.preventDefault()
        setIsDragging(false)
    }

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault()
        setIsDragging(false)
        const droppedFiles = Array.from(e.dataTransfer.files)
        addFiles(droppedFiles)
    }

    const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files) {
            const selectedFiles = Array.from(e.target.files)
            addFiles(selectedFiles)
        }
    }

    const addFiles = (newFiles: File[]) => {
        const fileItems: FileItem[] = newFiles.map((file) => ({
            id: Math.random().toString(36).substring(7),
            name: file.name,
            type: file.type,
            size: (file.size / 1024).toFixed(1) + ' KB',
        }))
        setFiles((prev) => [...prev, ...fileItems])
    }

    return (
        <div className="flex h-full w-80 flex-col border-l border-gray-200 bg-white">
            <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
                <h2 className="text-sm font-semibold text-gray-900">AI Context</h2>
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
                    {files.length} files
                </span>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
                {files.length === 0 ? (
                    <div className="flex h-40 flex-col items-center justify-center rounded-lg border-2 border-dashed border-gray-200 text-center">
                        <p className="text-sm text-gray-500">No files added</p>
                        <p className="mt-1 text-xs text-gray-400">Drag & drop or click to upload</p>
                    </div>
                ) : (
                    <ul className="space-y-2">
                        {files.map((file) => (
                            <li
                                key={file.id}
                                className="flex items-center justify-between rounded-md border border-gray-100 bg-gray-50 p-2"
                            >
                                <div className="flex items-center gap-2 overflow-hidden">
                                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-white text-xs font-bold text-gray-400 border border-gray-200">
                                        {file.name.split('.').pop()?.toUpperCase() || '?'}
                                    </div>
                                    <div className="min-w-0">
                                        <p className="truncate text-sm font-medium text-gray-700">{file.name}</p>
                                        <p className="text-xs text-gray-400">{file.size}</p>
                                    </div>
                                </div>
                                <button
                                    onClick={() => setFiles(files.filter((f) => f.id !== file.id))}
                                    className="ml-2 rounded p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-600"
                                >
                                    <svg
                                        xmlns="http://www.w3.org/2000/svg"
                                        width="14"
                                        height="14"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                    >
                                        <path d="M18 6 6 18" />
                                        <path d="m6 6 12 12" />
                                    </svg>
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            <div className="border-t border-gray-200 p-4">
                <div
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    onClick={() => fileInputRef.current?.click()}
                    className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 transition-colors ${isDragging
                            ? 'border-black bg-gray-50'
                            : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                        }`}
                >
                    <input
                        type="file"
                        multiple
                        className="hidden"
                        ref={fileInputRef}
                        onChange={handleFileInput}
                    />
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="24"
                        height="24"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="mb-2 text-gray-400"
                    >
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="17 8 12 3 7 8" />
                        <line x1="12" x2="12" y1="3" y2="15" />
                    </svg>
                    <p className="text-sm font-medium text-gray-600">Upload Context</p>
                    <p className="mt-1 text-xs text-gray-400">JSON, Images, Text</p>
                </div>
            </div>
        </div>
    )
}
