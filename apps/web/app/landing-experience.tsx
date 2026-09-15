"use client";

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import "./landing-story.css";
import "./landing-type.css";
import { journeyProgress } from "./spaceJourney";

const LunarScene = lazy(() => import("./lunar-scene").then(module => ({ default: module.LunarScene })));
const LunarBackground = lazy(() => import("./lunar-scene").then(module => ({ default: module.LunarBackground })));
const chapters = [
  { id: "privacy", name: "Private intent", title: ["Your edge.", "Yours to keep."], copy: "A public order book reveals your next move. Lunarveil begins with an encrypted limit order, keeping your price, size and strategy off the public ledger.", note: "Your intent enters the market behind a veil." },
  { id: "matching", name: "One shared moment", title: ["Less racing.", "More matching."], copy: "Orders meet in a batch. A deterministic rule finds a shared clearing price, with price priority and proportional fills at the margin. The outcome follows the rules of the batch.", note: "A common clearing price. A published matching rule." },
  { id: "verification", name: "Verifiable fairness", title: ["Trust the proof.", "Check the outcome."], copy: "The frozen order set anchors the result. Compact circuits check the clearing solution against that set, so an incorrect price or allocation can be rejected.", note: "Private inputs. Cryptographically checkable execution." },
];

export function LandingExperience() {
  const [reducedMotion, setReducedMotion] = useState(true);
  const travelProgress = useRef(0);
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update(); query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    let frame = 0;
    const paint = () => {
      const height = document.documentElement.scrollHeight - window.innerHeight;
      travelProgress.current = journeyProgress(window.scrollY, height);
      root.current?.style.setProperty("--travel-progress", String(travelProgress.current));
      frame = 0;
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(paint); };
    paint(); window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => { window.removeEventListener("scroll", onScroll); window.removeEventListener("resize", onScroll); cancelAnimationFrame(frame); };
  }, []);
  useEffect(() => {
    const element = root.current;
    if (!element || reducedMotion || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) entry.target.classList.toggle("is-arrived", entry.isIntersecting);
    }, { threshold: .08, rootMargin: "0px 0px -8% 0px" });
    element.querySelectorAll("[data-reveal]").forEach(target => observer.observe(target));
    element.classList.add("reveal-ready");
    return () => { observer.disconnect(); element.classList.remove("reveal-ready"); };
  }, [reducedMotion]);
  return <main ref={root} className={`lunar-story${reducedMotion ? " motion-reduced" : ""}`} id="top">
    <Suspense fallback={null}><LunarBackground reducedMotion={reducedMotion} travelProgress={travelProgress} /></Suspense>
    <div className="story-moon-layer" aria-hidden="true"><Suspense fallback={<div className="story-moon-fallback" />}><LunarScene reducedMotion={reducedMotion} travelProgress={travelProgress} /></Suspense></div>
    <a href="#journey" className="story-skip">Skip to product story</a>
    <header className="story-nav">
      <a href="#top" className="story-brand" aria-label="Lunarveil home"><span className="story-mark" />Lunarveil<span className="story-beta">PREVIEW</span></a>
      <nav aria-label="Main navigation"><a href="#journey">The protocol</a><a href="#principles">Why Lunarveil</a><a className="story-nav-cta" href="/markets">Explore markets ↗</a></nav>
    </header>
    <section className="story-hero" aria-labelledby="story-title">
      <div className="story-hero-shade" />
      <div className="story-hero-copy">
        <p className="story-kicker"><span className="story-status-dot" /> PRIVATE MARKETS. PUBLIC INTEGRITY.</p>
        <h1 id="story-title">Trade beyond<br />the <em>visible.</em></h1>
        <p className="story-lead">Your intent stays private.<br />The rules stay in the open.</p>
        <div className="story-actions"><a href="/markets" className="story-button">Explore markets <span aria-hidden="true">↗</span></a><a href="#journey" className="story-text-link">Discover Lunarveil ↓</a></div>
        <p className="story-network">Built on Midnight <span>·</span> Preview network</p>
      </div>
      <div className="story-hero-bottom"><a href="#journey">Scroll to explore ↓</a></div>
    </section>
    <section className="story-opening" id="journey" aria-labelledby="opening-title">
      <p className="story-kicker" data-reveal>THE MARKET DOESN’T NEED TO SEE EVERYTHING.</p>
      <h2 id="opening-title" data-reveal>Keep your strategy private.<br /><span>Make fairness verifiable.</span></h2>
      <div className="story-opening-bottom" data-reveal><span className="story-small-label">THE LUNARVEIL APPROACH</span><p>A private batch exchange built around a simple idea: you should be able to check how a market treats your order without exposing your next move to the world.</p></div>
    </section>
    <div className="story-journey">
      <div>{chapters.map((chapter, index) => <section key={chapter.id} id={chapter.id} className="story-chapter" aria-labelledby={`${chapter.id}-title`}>
        <div className="story-chapter-copy" data-reveal><p className="story-kicker">0{index + 1} / {chapter.name.toUpperCase()}</p><h2 id={`${chapter.id}-title`}>{chapter.title[0]}<br />{chapter.title[1]}</h2><p>{chapter.copy}</p><div className="story-chapter-note"><span aria-hidden="true">↳</span>{chapter.note}</div></div>
        <div className="story-diagram" data-reveal role="img" aria-label={index === 0 ? "An encrypted order hides price, size and strategy" : index === 1 ? "Buy and sell orders gather into a batch with one clearing price" : "Compact checks the frozen order set and published rule; altered allocations are rejected"}>
          <div className="diagram-top"><span>0{index + 1} / {["SEAL YOUR INTENT", "FIND THE CROSS", "VERIFY THE RESULT"][index]}</span><span>ILLUSTRATION</span></div>
          {index === 0 ? <div className="sealed-visual"><div className="sealed-card"><span className="sealed-label">PRIVATE LIMIT ORDER</span>{["Price", "Size", "Strategy"].map(label => <div key={label}><span>{label}</span><b>••••••</b></div>)}<footer>◇ ENCRYPTED INTENT</footer></div></div>
            : index === 1 ? <div className="batch-visual"><div className="batch-side"><span>BUY INTENT</span>{[78, 58, 92, 43].map((width, i) => <i key={i} style={{ width: `${width}%`, animationDelay: `${i * .3}s` }} />)}</div><div className="batch-center"><span>THE BATCH</span><div className="batch-cross">×</div><small>ONE CLEARING PRICE</small></div><div className="batch-side sell"><span>SELL INTENT</span>{[45, 86, 60, 76].map((width, i) => <i key={i} style={{ width: `${width}%`, animationDelay: `${i * .3}s` }} />)}</div></div>
            : <div className="proof-visual"><div className="proof-inputs"><span>Frozen order set</span><span>Published rule</span></div><div className="proof-connector" /><div className="proof-core"><span className="proof-check">✓</span><span>COMPACT PROOF</span></div><div className="proof-result"><span>Correct solution</span><b>Verifiable</b></div><div className="proof-result invalid"><span>Altered allocation</span><b>Rejected</b></div></div>}
        </div>
      </section>)}</div>
    </div>
    <section className="story-principles" id="principles" aria-labelledby="principles-title">
      <div data-reveal><p className="story-kicker">CLEAR RULES. CLEAR BOUNDARIES.</p><h2 id="principles-title">Privacy with<br /><em>nothing to hide.</em></h2></div>
      <div className="principle-list" data-reveal><article><span>01</span><div><h3>Private from public view</h3><p>Order price, size and strategy stay off the public ledger. In V1, the matcher decrypts orders to calculate the batch.</p></div></article><article><span>02</span><div><h3>Fairness by a published rule</h3><p>The same frozen inputs produce the same result. The bounded N=4 proof checks the clearing price and allocations.</p></div></article><article><span>03</span><div><h3>A deliberate path to settlement</h3><p>Matching comes first. Exact fills are then intended to move through participant firm-up and shielded settlement. The full live flow is still in development.</p></div></article></div>
    </section>
    <section id="finale" className="story-finale" aria-labelledby="finale-title"><div data-reveal><p className="story-kicker"><span className="story-status-dot" /> BUILT ON MIDNIGHT</p><h2 id="finale-title">A clearer market.<br /><em>A quieter footprint.</em></h2><p>Explore the next chapter of private exchange.</p><a className="story-button" href="/markets">Enter Lunarveil ↗</a><small>Preview network · Protocol in development</small></div></section>
    <footer className="story-footer"><a className="story-brand" href="#top"><span className="story-mark" />Lunarveil</a><span>Private intent. Public integrity.</span><a href="#top">Back to the surface ↑</a></footer>
  </main>;
}
