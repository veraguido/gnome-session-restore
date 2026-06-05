UUID       = session-restore@guido.local
INSTALLDIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SRCFILES   = metadata.json extension.js prefs.js
SCHEMADIR  = schemas
SCHEMAXML  = $(SCHEMADIR)/org.gnome.shell.extensions.session-restore.gschema.xml

.PHONY: all install uninstall enable disable restart logs pack clean

all: compile-schemas

# Compile schemas in-tree (useful for validation before install)
compile-schemas:
	glib-compile-schemas $(SCHEMADIR)/

install: compile-schemas
	@echo "Installing $(UUID) to $(INSTALLDIR) ..."
	mkdir -p $(INSTALLDIR)/schemas
	cp $(SRCFILES) $(INSTALLDIR)/
	cp $(SCHEMAXML) $(INSTALLDIR)/schemas/
	glib-compile-schemas $(INSTALLDIR)/schemas/
	@echo "Done. Run 'make enable' or enable via GNOME Extensions."

uninstall:
	@echo "Removing $(INSTALLDIR) ..."
	rm -rf $(INSTALLDIR)

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

# X11 only — on Wayland, log out and back in.
restart:
	@if [ "$$XDG_SESSION_TYPE" = "wayland" ]; then \
		echo "Wayland detected: log out and back in to restart GNOME Shell."; \
	else \
		busctl --user call org.gnome.Shell /org/gnome/Shell org.gnome.Shell Eval s 'Meta.restart("Restarting…", global.context)'; \
	fi

# Stream extension logs from the journal
logs:
	journalctl -f -o cat /usr/bin/gnome-shell 2>/dev/null \
		| grep --line-buffered '\[SessionRestore\]'

# Create a distributable zip
pack: compile-schemas
	@rm -f $(UUID).zip
	zip -r $(UUID).zip $(SRCFILES) $(SCHEMADIR)/
	@echo "Created $(UUID).zip"

clean:
	rm -f $(SCHEMADIR)/gschemas.compiled $(UUID).zip
