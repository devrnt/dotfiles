#!/bin/bash

# This script is meant for a new machine to quickly setup and install applications

echo "Setting up your Mac..."

# Install XCode CLI tools
xcode-select --install

# Install Oh My Zsh and if we don't have it
if test ! $(which omz); then
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
fi

# Install Homebrew if we don't have it
if test ! $(which brew); then
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
fi

# Update Homebrew recipes
brew update

# Manually install stow for symlinking
brew install stow

# Symblink packages
stow zsh homebrew git aerospace ssh

# Install homebrew packages
brew bundle install
