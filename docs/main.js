// Fjord's website: the illustrations revealing as you reach them, the feature list, the questions opening smoothly,
// and the dawn footer
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
gsap.registerPlugin(ScrollTrigger);
document.fonts.ready.then(() => ScrollTrigger.refresh());

// Smooth scrolling for the page's own links. Not CSS scroll-behavior, which throws off ScrollTrigger's measuring
document.addEventListener("click", e => {
  const link = e.target.closest('a[href^="#"]');
  const target = link && document.querySelector(link.getAttribute("href"));
  if (!target) return;
  e.preventDefault();
  target.scrollIntoView({ behavior: reduce ? "auto" : "smooth" });
  history.pushState(null, "", link.getAttribute("href"));
});

// The nav is clear over the hero and solid after it
const nav = document.querySelector(".nav");
new IntersectionObserver(([e]) => nav.classList.toggle("solid", !e.isIntersecting), { rootMargin: "-64px 0px 0px 0px" })
  .observe(document.querySelector(".hero"));

// ---------- Smaller moments ----------
if (!reduce) {
  // Each illustration opens from the bottom up as it comes into view, once
  // (on the image itself: a clip on the figure would isolate it, and the paper would stop blending into the page)
  for (const art of document.querySelectorAll(".art")) {
    gsap.from(art.querySelector("img"), {
      clipPath: "inset(100% 0 0 0)", scale: 1.08, duration: 1.2, ease: "expo.out", clearProps: "clipPath,transform",
      scrollTrigger: { trigger: art, start: "top 85%" },
    });
  }
  // The dawn ridges settle into place, the far ones moving most
  gsap.timeline({ scrollTrigger: { trigger: ".dawn", start: "top bottom", end: "bottom bottom", scrub: 0.5 } })
    .from(".dawn .far", { y: 60, ease: "none" }, 0)
    .from(".dawn .mid", { y: 30, ease: "none" }, 0);
}

// ---------- Also in Fjord: pick a feature and its illustration opens beside the list ----------
const tabs = [...document.querySelectorAll('.picker [role="tab"]')];
const panels = tabs.map(t => document.getElementById(t.getAttribute("aria-controls")));
let current = 0, playing = null;

// The same reveal as the Shields drawings, quicker; one cut short jumps to its end
function play(panel, now = true) {
  playing?.progress(1).kill();
  playing = null;
  if (reduce) return;
  const img = panel.querySelector("img"), tl = gsap.timeline({ paused: true })
    .from(img, { clipPath: "inset(100% 0 0 0)", scale: 1.06, duration: 0.8, ease: "expo.out", clearProps: "clipPath,transform" }, 0)
    .from(panel.querySelector("p"), { opacity: 0, y: 8, duration: 0.4, ease: "expo.out" }, 0.15);
  // A drawing still downloading opens once it's there, instead of opening empty
  const loaded = img.complete ? Promise.resolve() : new Promise(r => { img.addEventListener("load", r, { once: true }); img.addEventListener("error", r, { once: true }); });
  tl.go = () => loaded.then(() => { if (playing === tl) tl.play(); });
  playing = tl;
  if (now) tl.go();
}

function show(i, focus = false) {
  current = i;
  tabs.forEach((t, j) => {
    t.setAttribute("aria-selected", String(j === i));
    t.tabIndex = j === i ? 0 : -1;
    panels[j].hidden = j !== i;
  });
  if (focus) tabs[i].focus();
  tabs[i].scrollIntoView({ block: "nearest", inline: "nearest", behavior: reduce ? "auto" : "smooth" }); // the row of buttons on phones
  play(panels[i]);
}

if (tabs.length) {
  panels.forEach((p, j) => { p.hidden = j !== 0; });
  tabs.forEach((t, i) => t.addEventListener("click", () => { if (i !== current) show(i); }));
  document.querySelector(".picker").addEventListener("keydown", e => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    const to = step ? (current + step + tabs.length) % tabs.length : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
    if (to == null) return;
    e.preventDefault();
    show(to, true);
  });
  // The first one opens once it comes into view, and the other drawings load then, so they're ready when picked
  play(panels[0], false);
  ScrollTrigger.create({ trigger: ".explorer", start: "top 65%", once: true, onEnter: () => {
    playing?.go();
    for (const p of panels) p.querySelector("img").loading = "eager";
  } });
}

// ---------- Questions open and close smoothly, and can be turned around halfway ----------
for (const d of document.querySelectorAll(".faq details")) {
  const answer = d.querySelector("p");
  d.querySelector("summary").addEventListener("click", e => {
    if (reduce) return;
    e.preventDefault();
    gsap.killTweensOf(answer);
    if (!d.open || d.classList.contains("closing")) {
      if (!d.open) gsap.set(answer, { height: 0, paddingBottom: 0, opacity: 0 });
      d.classList.remove("closing");
      d.open = true;
      gsap.to(answer, { height: "auto", paddingBottom: 22, opacity: 1, duration: 0.45, ease: "expo.out", clearProps: "height,paddingBottom,opacity" });
    } else {
      d.classList.add("closing");
      gsap.to(answer, { height: 0, paddingBottom: 0, opacity: 0, duration: 0.3, ease: "power3.inOut",
        onComplete: () => { d.open = false; d.classList.remove("closing"); gsap.set(answer, { clearProps: "height,paddingBottom,opacity" }); } });
    }
  });
}
