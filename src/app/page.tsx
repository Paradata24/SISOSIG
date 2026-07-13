import WindMapLoader from "@/components/WindMapLoader";

export default function Home() {
  return (
    <div className="flex h-dvh w-dvh flex-col">
      <header className="border-b border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-black">
        <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
          Should I stay or should I go
        </h1>
      </header>
      <main className="flex-1">
        <WindMapLoader />
      </main>
    </div>
  );
}
