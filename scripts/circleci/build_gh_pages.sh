#!/bin/bash

set -e

if [ -z $CI_PULL_REQUEST ] && [ "$CIRCLE_BRANCH" = "$REACT_WEBSITE_BRANCH" ]; then

  GH_PAGES_DIR=`pwd`/../react-gh-pages
  echo "machine github.com login zpao password $GITHUB_TOKEN" >~/.netrc
  git config --global user.name "Travis CI"
  git config --global user.email "travis@reactjs.org"

  # TODO: check if directory exists (restored from cache)
  if [ -d $GH_PAGES_DIR ]; then
    pushd $GH_PAGES_DIR
    git pull origin gh-pages
    popd
  else
    git clone --branch gh-pages --depth=1 \
      https://zpao@github.com/zpao/react.git \
      $GH_PAGES_DIR
  fi

  pushd docs
  bundle exec rake release
  cd $GH_PAGES_DIR
  git status
  git --no-pager diff
  if ! git diff-index --quiet HEAD --; then
    git add -A .
    git commit -m "Rebuild website"
    git push origin gh-pages
  fi
  popd
else
  echo "Not building website"
fi
