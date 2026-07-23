/* Entry for the legal pages. Exists solely so Vite emits the hashed stylesheet
   for them — a plain <link> to a file in public/ would duplicate the design
   tokens, and the strict CSP forbids the inline <style> that would otherwise be
   the lazy way out. */
import "./style.css";
