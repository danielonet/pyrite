# Sample Python project

A small "inventory and orders" application used to demonstrate the Pyrite
extension. It deliberately uses a broad mix of Python features: dataclasses,
enums, properties, comprehensions, f-strings, exceptions, context managers,
generators and a Spring-Batch-like reader/processor/writer job.

Run it with:

    python main.py

Generate the Java view with the CLI (from the extension folder):

    npm run cli -- sample-python-project
