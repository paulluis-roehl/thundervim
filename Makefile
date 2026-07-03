# Thundervim build tasks.
#
# Thin wrappers around the npm scripts so `make` works as a familiar entry
# point; the real build logic lives in scripts/build.js. Running `make` with
# no target builds the packaged .xpi.

NPM := npm

.DEFAULT_GOAL := build
.PHONY: all build watch check typecheck test clean

## build:     bundle the add-on and package dist/thundervim-<version>.xpi
build: node_modules
	$(NPM) run build

## all:       type-check, run tests, then build the package
all: check build

## watch:     rebuild on every change (load dist/thundervim/ in Thunderbird)
watch: node_modules
	$(NPM) run watch

## check:     strict type-check + engine test suite
check: node_modules
	$(NPM) run check

## typecheck: strict type-check only
typecheck: node_modules
	$(NPM) run typecheck

## test:      run the engine test suite
test: node_modules
	$(NPM) run test

## clean:     remove build output
clean:
	rm -rf dist

# Install dev dependencies whenever the lockfile or manifest changes.
node_modules: package.json package-lock.json
	$(NPM) install
	@touch node_modules
