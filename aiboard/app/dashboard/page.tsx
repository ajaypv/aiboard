import Whiteboard from '../components/Whiteboard'
import ContextPanel from '../components/ContextPanel'
import Timer from '../components/Timer'

export default function DashboardPage() {
    return (
        <div className="flex h-screen w-screen flex-col bg-white text-black">
            <header className="flex items-center justify-between border-b border-gray-200 px-6 py-3">
                <div className="flex items-center gap-2 w-1/3">
                    <div className="h-6 w-6 rounded-md bg-black"></div>
                    <span className="text-lg font-semibold tracking-tight">aiboard</span>
                </div>

                <div className="flex justify-center w-1/3">
                    <Timer />
                </div>

                <div className="flex items-center justify-end gap-3 w-1/3">
                    <button className="rounded-full bg-gray-100 px-4 py-2 text-sm font-medium text-black hover:bg-gray-200 transition-colors">
                        Share
                    </button>
                    <div className="h-8 w-8 rounded-full bg-gray-300"></div>
                </div>
            </header>
            <main className="flex flex-1 overflow-hidden">
                <div className="flex-1 relative">
                    <Whiteboard />
                </div>
                <ContextPanel />
            </main>
        </div>
    )
}
