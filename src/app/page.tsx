import WindApp from "@/components/WindApp";

export default function Home() {
  return (
    <div className="flex h-dvh w-full flex-col">
      <WindApp />
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
