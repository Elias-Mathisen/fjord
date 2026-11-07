// Fjord's website: smooth scrolling to its sections, the nav over the hero, the questions opening smoothly, and the
// dawn footer
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- Get Fjord: the visitor's own device is the highlighted card, and the hero's button is for it ----------
// First, so it still works if the animation library doesn't load. iPads ask for the desktop site, so they say Macintosh; touch gives them away
const ua = navigator.userAgent;
const os = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? "iphone"
  : /Macintosh/.test(ua) ? "mac" : /Windows/.test(ua) ? "windows" : /Linux/.test(ua) && !/Android/.test(ua) ? "linux" : null;
const yours = os && document.querySelector(`.platform[data-os="${os}"]`);
if (yours) {
  yours.classList.add("yours");
  const card = yours.querySelector(".btn"), hero = document.querySelector(".hero-actions .btn");
  hero.href = card.href;
  hero.textContent = os === "iphone" ? "Get it on the App Store" : card.getAttribute("aria-label");
  if (os !== "windows") document.querySelector(".hero-actions .muted").innerHTML = 'Free · <a href="#download">Every platform</a>';
}

gsap.registerPlugin(ScrollTrigger);
document.fonts.ready.then(() => ScrollTrigger.refresh());

// Smooth scrolling for the page's own links
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

// The dawn ridges settle into place as the page ends, the far ones moving most
if (!reduce) {
  gsap.timeline({ scrollTrigger: { trigger: ".dawn", start: "top bottom", end: "bottom bottom", scrub: 0.5 } })
    .from(".dawn .far", { y: 60, ease: "none" }, 0)
    .from(".dawn .mid", { y: 30, ease: "none" }, 0);
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
