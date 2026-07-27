import WindApp from "@/components/WindApp";
import { FORECAST_MODELS } from "@/lib/wind";

export default function Home() {
  return (
    <div className="flex h-dvh w-full flex-col">
      <WindApp />
      <footer className="border-t border-zinc-200 bg-white px-4 py-1.5 text-center text-[11px] text-zinc-500 dark:border-zinc-800 dark:bg-black dark:text-zinc-400">
        <p>
          Winddaten &copy; contributors of the OpenWindMap wind network —{" "}
          <a
            href="https://openwindmap.org"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-zinc-700 dark:hover:text-zinc-200"
          >
            openwindmap.org
          </a>
        </p>
        {/* Nennung der Wetterdienste hinter den vier Prognosemodellen. Die
            Namen stammen aus FORECAST_MODELS (src/lib/wind.ts), damit ein
            weiteres Modell hier automatisch mit auftaucht. */}
        <p>
          Prognosedaten:{" "}
          {FORECAST_MODELS.map((m, i) => (
            <span key={m.key}>
              {i > 0 && ", "}
              {m.provider} ({m.licenseLabel ?? m.label})
            </span>
          ))}{" "}
          – via{" "}
          <a
            href="https://open-meteo.com"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-zinc-700 dark:hover:text-zinc-200"
          >
            Open-Meteo
          </a>
        </p>
      </footer>
    </div>
  );
}
