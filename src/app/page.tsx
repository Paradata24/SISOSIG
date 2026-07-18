import WindMapLoader from "@/components/WindMapLoader";

export default function Home() {
  return (
    <div className="flex h-dvh w-full flex-col">
      <header className="border-b border-zinc-200 bg-white px-4 py-3 text-center dark:border-zinc-800 dark:bg-black">
        <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
          Should I stay or should I go
        </h1>
      </header>
      <main className="flex-1">
        <WindMapLoader />
      </main>
      <footer className="border-t border-zinc-200 bg-white px-4 py-1.5 text-center text-[11px] text-zinc-500 dark:border-zinc-800 dark:bg-black dark:text-zinc-400">
        Winddaten &copy; contributors of the OpenWindMap wind network —{" "}
        <a
          href="https://openwindmap.org"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-zinc-700 dark:hover:text-zinc-200"
        >
          openwindmap.org
        </a>
      </footer>
    </div>
  );
}
