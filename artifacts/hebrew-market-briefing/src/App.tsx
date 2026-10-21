import { Bell, Clock3, Send } from "lucide-react";

const botUrl = "https://t.me/Oriel_news_bot";

export default function App() {
  return (
    <main className="briefline-shell grid min-h-[100dvh] place-items-center px-5 py-12">
      <section
        dir="rtl"
        className="w-full max-w-xl rounded-3xl border border-border bg-card p-7 shadow-xl sm:p-10"
      >
        <div className="mb-8 flex items-center gap-3">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-primary text-primary-foreground">
            <Send size={22} />
          </div>
          <div>
            <p className="text-xl font-bold tracking-tight">Briefline</p>
            <p className="text-sm text-muted-foreground">בוט חדשות בטלגרם</p>
          </div>
        </div>

        <p className="text-xs font-semibold tracking-[.16em] text-accent">
          חדשות עם הקשר, בעברית
        </p>
        <h1 className="serif-display mt-3 text-4xl leading-tight sm:text-5xl">
          פחות כותרות.
          <br />
          <span className="text-primary">יותר הבנה.</span>
        </h1>
        <p className="mt-5 text-base leading-7 text-muted-foreground">
          הבוט עוקב אחר חדשות עולם, הצהרות טראמפ ושוקי המניות — כולל S&amp;P 500,
          Nasdaq, Nvidia, Tesla, בינה מלאכותית ושבבים. כל תדרוך מסביר מה קרה,
          למה זה חשוב ומה עשויה להיות ההשפעה על השוק, עם קישור למקור.
        </p>

        <a
          href={botUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-8 flex w-full items-center justify-center gap-3 rounded-xl bg-primary px-5 py-4 font-semibold text-primary-foreground transition hover:opacity-90"
        >
          <Send size={18} />
          פתיחת @Oriel_news_bot
        </a>

        <div className="mt-8 grid gap-4 border-t border-border pt-6 sm:grid-cols-2">
          <div className="flex gap-3">
            <Clock3 className="mt-1 shrink-0 text-primary" size={18} />
            <p className="text-sm leading-6 text-muted-foreground">
              מקורות נבדקים כל 15 דקות. תדרוך נשלח בכל שעה כברירת מחדל.
            </p>
          </div>
          <div className="flex gap-3">
            <Bell className="mt-1 shrink-0 text-primary" size={18} />
            <p className="text-sm leading-6 text-muted-foreground">
              כל ההגדרות והפקודות נמצאות בטלגרם. שלחו /help אחרי /start.
            </p>
          </div>
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          הסברים על השוק הם הערכות אפשריות בלבד, לא תחזית ולא ייעוץ השקעות.
        </p>
      </section>
    </main>
  );
}
