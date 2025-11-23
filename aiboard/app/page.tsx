import Link from 'next/link'

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-white text-black p-8">
      <main className="flex flex-col items-center gap-8 text-center max-w-2xl">
        <div className="h-12 w-12 rounded-lg bg-black mb-4"></div>
        <h1 className="text-5xl font-bold tracking-tighter sm:text-7xl">
          Think clearer. <br />
          Build faster.
        </h1>
        <p className="text-xl text-gray-500 max-w-md mx-auto">
          The minimal whiteboard for developers and teams who value clarity over clutter.
        </p>

        <div className="flex gap-4 mt-8">
          <Link
            href="/dashboard"
            className="rounded-full bg-black px-8 py-3 text-white font-medium hover:bg-gray-800 transition-colors"
          >
            Start Drawing
          </Link>
          <a
            href="#"
            className="rounded-full border border-gray-200 px-8 py-3 text-black font-medium hover:bg-gray-50 transition-colors"
          >
            Learn More
          </a>
        </div>
      </main>

      <footer className="absolute bottom-8 text-sm text-gray-400">
        © 2024 aiboard. All rights reserved.
      </footer>
    </div>
  )
}
