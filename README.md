# Dotfiles

## Installation

1. Install [stow](https://www.gnu.org/software/stow/)

```sh
brew install stow
```

2. Navigate to your home directory

```sh
cd ~
```

3. Clone repository

```sh
git clone https://github.com/devrnt/dotfiles
```

4. Navigate to `dotfiles` folder

```sh
cd dotfiles
```

5. Install package settings

```sh
stow git homebrew zsh aerospace ssh # add anything you want
```

## Extra

Run `./install.sh` to setup a new machine

## Adding New Configs

To add a new configuration to your dotfiles:

1. Create a new directory in the dotfiles folder (e.g., `vim`, `tmux`, etc.)

```sh
mkdir -p dotfiles/vim
```

2. Add your config files with a dot prefix (e.g., `.vimrc`)

```sh
# Example: create vim/.vimrc
vim dotfiles/vim/.vimrc
```

3. Update `install.sh` to include the new config in the stow command

```sh
# Change this line:
stow zsh homebrew git aerospace ssh

# To include your new config:
stow zsh homebrew git aerospace ssh vim
```

4. Update the README.md example command to include the new config

5. Run stow to symlink the new config

```sh
cd ~/dotfiles
stow vim
```

The config will be symlinked to your home directory (e.g., `~/.vimrc`).

## References

- https://github.com/dotphiles/dotphiles
- https://github.com/xero/dotfiles
- https://github.com/driesvints/dotfiles
- https://github.com/sam-dt/dotfiles
- https://dotfiles.github.io/
- https://markentier.tech/posts/2021/02/github-with-multiple-profiles-gpg-ssh-keys/
