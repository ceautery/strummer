"""A tiny greeter module for the `strummer lsp` quickstart."""


def hello(name: str) -> str:
    """A free function the Greeter calls — gives `call-hierarchy` a real caller->callee edge."""
    return f"Hello, {name}!"


class Greeter:
    """The greeter class — imported and instantiated in `main.py`."""

    def __init__(self, name: str) -> None:
        self.name = name

    def greet(self) -> str:
        return hello(self.name)
