# pyrite
read Python as if it were Java

Developers today, Java developers included, increasingly write code with AI. That changes what it means to join a project in an unfamiliar language. A Java developer dropped into a Python codebase no longer has to close the language gap before contributing, because the AI can write the Python. The real risk is the opposite: shipping code you cannot read. That is vibe coding, and it leaves the developer unable to review, reason about, or take responsibility for what the application does.

Pyrite closes that gap on the reading side. It is a Visual Studio Code extension that mirrors an entire Python project into a .java-view folder with the same directory structure, translating each module into a Java-flavored reading view. Classes stay classes, functions become typed methods, comprehensions become streams, raise becomes throw new, and docstrings become Javadoc. Names and ordering are preserved, so everything in the view is easy to find in the original file. Saving a Python file refreshes its view instantly, and one shortcut jumps between corresponding lines in both directions.

The name is the disclaimer. Pyrite is fool's gold: it looks like Java but is not, and it is never meant to compile. It is a faithful lens on the Python underneath.

The result is Supervised Development instead of vibe coding. A Java developer can read the AI's output at a developer level, understand the design, review changes, and steer the application deliberately. Phase 2, editing the Java view and syncing changes back to Python, is on the roadmap.
